# frozen_string_literal: true

require_relative '../test_helper'

class VisGanttsControllerTest < Redmine::ControllerTest
  def setup
    super
    @project = Project.find(1)
    @today = User.current.today
    @request.session[:user_id] = 2 # jsmith, Manager of project 1
  end

  # The versions in the fixtures are closed or locked, issues cannot target them.
  def open_version(effective_date = @today + 30)
    Version.create!(project: @project, name: 'vis gantt test', status: 'open', effective_date: effective_date)
  end

  # ----------------------------------------------------------------- show

  def test_show_renders_the_chart_container_with_embedded_data
    get :show, params: { project_id: 1 }

    assert_response :success
    assert_select 'form#query_form'
    assert_select 'div#vis-gantt[data-config]'
    config = JSON.parse(css_select('#vis-gantt').first['data-config'])
    assert_equal "/projects/#{@project.identifier}/vis_gantt/data", config['dataUrl'].split('?').first
    assert_equal '/vis_gantt/issues/__ID__/dates', config['updateUrlTemplate']
    assert config['initial']['rows'].any?
  end

  def test_show_has_a_loading_placeholder_that_stays_if_the_script_never_runs
    get :show, params: { project_id: 1 }

    assert_response :success
    assert_select 'div#vis-gantt p.vg-loading', /Loading the chart/
    assert_select '#vis-gantt-assets-missing', 0
  end

  def test_show_has_the_regions_the_script_fills_in
    get :show, params: { project_id: 1 }

    assert_response :success
    assert_select '.vg-app' do
      assert_select '#vis-gantt-toolbar[role=toolbar][aria-label]'
      assert_select '#vis-gantt-details[role=region][aria-label]'
      assert_select '#vis-gantt-help[hidden]'
      assert_select 'ul#vis-gantt-legend'
    end
    assert_select 'link[rel=stylesheet][media=all][href*=vis_gantt]'
  end

  def test_show_sends_every_text_the_script_needs_in_the_users_language
    %w[en ru de].each do |language|
      User.find(2).update_columns(language: language)
      @request.session[:user_id] = 2

      get :show, params: { project_id: 1 }

      texts = JSON.parse(css_select('#vis-gantt').first['data-config'])['i18n'].values.flatten
      assert texts.any?, language
      assert texts.none? { |text| text.to_s.strip.empty? || text.to_s.include?('translation missing') }, "missing text in #{language}"
    end
  end

  def test_the_locale_files_define_the_same_keys
    dir = File.expand_path('../../config/locales', __dir__)
    en = YAML.load_file(File.join(dir, 'en.yml'))['en']
    ru = YAML.load_file(File.join(dir, 'ru.yml'))['ru']

    assert_equal en.keys.sort, ru.keys.sort
    assert en.keys.any? { |key| key.start_with?('label_vis_gantt') }
  end

  def test_show_explains_how_to_fix_it_when_the_plugin_assets_are_not_compiled
    RedmineVisGantt.stubs(:assets_available?).returns(false)

    get :show, params: { project_id: 1 }

    assert_response :success
    assert_select '#vis-gantt-assets-missing.flash.error' do
      assert_select 'code', 'RAILS_ENV=production bundle exec rake assets:precompile'
    end
    assert_select 'div#vis-gantt', 0
    assert_select 'form#query_form' # the rest of the page still works
  end

  def test_show_without_project_lists_all_visible_projects
    get :show

    assert_response :success
    assert_select 'div#vis-gantt'
  end

  def test_show_with_invalid_filter_shows_the_errors_instead_of_the_chart
    get :show, params: { project_id: 1, set_filter: 1, f: ['start_date'], op: { start_date: '=' }, v: { start_date: ['not a date'] } }

    assert_response :success
    assert_select '#errorExplanation'
    assert_select 'div#vis-gantt', 0
  end

  def test_show_requires_the_view_gantt_permission
    Role.find(1).remove_permission!(:view_gantt)

    get :show, params: { project_id: 1 }

    assert_response :forbidden
  end

  def test_show_requires_the_gantt_module
    @project.disable_module!(:gantt)

    get :show, params: { project_id: 1 }

    assert_response :forbidden
  end

  def test_show_is_available_to_anonymous_when_the_role_allows_it
    @request.session[:user_id] = nil
    Role.anonymous.add_permission!(:view_gantt)

    get :show, params: { project_id: 1 }

    assert_response :success
  end

  # ----------------------------------------------------------------- data

  def test_data_describes_projects_versions_and_issues_in_gantt_order
    version = open_version
    with_dates = Issue.generate!(project: @project, fixed_version: version,
                                 start_date: @today, due_date: @today + 10, done_ratio: 30)

    get :data, params: { project_id: 1 }

    assert_response :success
    body = response.parsed_body
    rows = body['rows']
    project_row = rows.find { |r| r['id'] == 'p1' }
    version_row = rows.find { |r| r['id'] == "v#{version.id}p1" }
    issue_row = rows.find { |r| r['id'] == "i#{with_dates.id}" }

    assert_equal 'project', project_row['kind']
    assert_nil project_row['parent']
    assert_equal 0, project_row['depth']
    assert_equal 'version', version_row['kind']
    assert_equal 'p1', version_row['parent']
    assert_equal 'issue', issue_row['kind']
    assert_equal version_row['id'], issue_row['parent']
    assert_equal 2, issue_row['depth']
    assert_equal with_dates.subject, issue_row['name']
    assert_equal @today.to_s, issue_row['start']
    assert_equal (@today + 10).to_s, issue_row['due']
    assert_equal 30, issue_row['done_ratio']
    assert_equal "/issues/#{with_dates.id}", issue_row['url']
    # parents come before their children
    assert_operator rows.index(project_row), :<, rows.index(version_row)
    assert_operator rows.index(version_row), :<, rows.index(issue_row)
  end

  def test_data_is_a_session_authenticated_non_api_request
    # Requests for *.json are API requests in Redmine and ignore the session.
    get :data, params: { project_id: 1 }

    assert_response :success
    assert_equal 'application/json', response.media_type
  end

  def test_data_nests_child_issues_below_their_parent
    parent = Issue.generate!(project: @project, start_date: @today, due_date: @today + 10)
    child = Issue.generate!(project: @project, parent_issue_id: parent.id,
                            start_date: @today + 1, due_date: @today + 5)

    get :data, params: { project_id: 1 }

    rows = response.parsed_body['rows']
    parent_row = rows.find { |r| r['id'] == "i#{parent.id}" }
    child_row = rows.find { |r| r['id'] == "i#{child.id}" }
    assert_equal parent_row['id'], child_row['parent']
    assert_equal parent_row['depth'] + 1, child_row['depth']
  end

  def test_data_flags_parents_with_derived_dates_as_not_editable
    parent = Issue.generate!(project: @project)
    Issue.generate!(project: @project, parent_issue_id: parent.id, start_date: @today, due_date: @today + 5)

    with_settings parent_issue_dates: 'derived' do
      get :data, params: { project_id: 1 }
    end

    row = response.parsed_body['rows'].find { |r| r['id'] == "i#{parent.id}" }
    assert row['derived']
    assert_equal({ 'start' => false, 'due' => false }, row['editable'])
  end

  def test_data_marks_the_dates_editable_for_users_who_may_edit_issues
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)

    get :data, params: { project_id: 1 }

    row = response.parsed_body['rows'].find { |r| r['id'] == "i#{issue.id}" }
    assert_equal({ 'start' => true, 'due' => true }, row['editable'])
  end

  def test_data_marks_the_dates_read_only_when_the_workflow_says_so
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    WorkflowPermission.create!(role_id: 1, tracker_id: issue.tracker_id, old_status_id: issue.status_id,
                               field_name: 'due_date', rule: 'readonly')

    get :data, params: { project_id: 1 }

    row = response.parsed_body['rows'].find { |r| r['id'] == "i#{issue.id}" }
    assert_equal({ 'start' => true, 'due' => false }, row['editable'])
  end

  def test_data_marks_the_dates_not_editable_without_the_edit_issues_permission
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    Role.find(1).remove_permission!(:edit_issues)

    get :data, params: { project_id: 1 }

    row = response.parsed_body['rows'].find { |r| r['id'] == "i#{issue.id}" }
    assert_equal({ 'start' => false, 'due' => false }, row['editable'])
  end

  def test_data_draws_issues_with_a_single_date_as_a_one_day_bar
    only_due = Issue.generate!(project: @project, start_date: nil, due_date: @today + 3)
    only_start = Issue.generate!(project: @project, start_date: @today + 4, due_date: nil)
    none = Issue.generate!(project: @project, start_date: nil, due_date: nil)

    get :data, params: { project_id: 1 }

    rows = response.parsed_body['rows']
    r1 = rows.find { |r| r['id'] == "i#{only_due.id}" }
    r2 = rows.find { |r| r['id'] == "i#{only_start.id}" }
    r3 = rows.find { |r| r['id'] == "i#{none.id}" }
    assert_equal [(@today + 3).to_s, (@today + 3).to_s], [r1['start'], r1['due']]
    assert_equal [(@today + 4).to_s, (@today + 4).to_s], [r2['start'], r2['due']]
    assert_nil r3['start']
    assert_nil r3['due']
  end

  def test_data_takes_the_due_date_from_the_version_when_the_issue_has_none
    version = open_version
    issue = Issue.generate!(project: @project, fixed_version: version, start_date: @today - 2, due_date: nil)

    get :data, params: { project_id: 1 }

    row = response.parsed_body['rows'].find { |r| r['id'] == "i#{issue.id}" }
    assert_equal version.effective_date.to_s, row['due']
    assert row['due_inherited']
  end

  def test_data_computes_progress_and_the_part_that_is_behind_schedule
    behind = Issue.generate!(project: @project, start_date: @today - 10, due_date: @today + 10, done_ratio: 0)
    on_time = Issue.generate!(project: @project, start_date: @today - 10, due_date: @today + 10, done_ratio: 90)
    future = Issue.generate!(project: @project, start_date: @today + 5, due_date: @today + 15, done_ratio: 0)

    get :data, params: { project_id: 1 }

    rows = response.parsed_body['rows']
    behind_row = rows.find { |r| r['id'] == "i#{behind.id}" }
    on_time_row = rows.find { |r| r['id'] == "i#{on_time.id}" }
    future_row = rows.find { |r| r['id'] == "i#{future.id}" }

    assert_in_delta 0.0, behind_row['progress'], 0.0001
    # 11 of the 21 days have passed
    assert_in_delta 11 / 21.0, behind_row['late_to'], 0.0001
    assert_in_delta 0.9, on_time_row['progress'], 0.0001
    assert_nil on_time_row['late_to']
    assert_nil future_row['late_to']
  end

  def test_data_includes_only_the_relation_types_the_builtin_gantt_draws_between_displayed_issues
    a = Issue.generate!(project: @project, start_date: @today, due_date: @today + 2)
    b = Issue.generate!(project: @project, start_date: @today + 3, due_date: @today + 5)
    c = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    IssueRelation.create!(issue_from: a, issue_to: b, relation_type: 'precedes')
    IssueRelation.create!(issue_from: c, issue_to: a, relation_type: 'relates')

    get :data, params: { project_id: 1 }

    relations = response.parsed_body['relations']
    assert_includes relations, { 'from' => "i#{a.id}", 'to' => "i#{b.id}", 'type' => 'precedes' }
    assert_not(relations.any? { |r| r['type'] == 'relates' })
  end

  def test_data_nests_subprojects_below_their_parent_project
    sub = Project.find(3) # subproject of project 1 in the fixtures
    Issue.generate!(project: sub, start_date: @today, due_date: @today + 2)

    get :data, params: { project_id: 1 }

    rows = response.parsed_body['rows']
    parent_row = rows.find { |r| r['id'] == 'p1' }
    sub_row = rows.find { |r| r['id'] == "p#{sub.id}" }
    assert_equal sub.parent_id, sub.parent.id
    assert_equal parent_row['id'], sub_row['parent']
    assert_equal 1, sub_row['depth']
  end

  def test_data_summarizes_the_dates_of_everything_below_a_project
    Issue.generate!(project: @project, start_date: @today - 100, due_date: @today - 90)
    Issue.generate!(project: @project, start_date: @today + 90, due_date: @today + 100)

    get :data, params: { project_id: 1 }

    row = response.parsed_body['rows'].find { |r| r['id'] == 'p1' }
    assert_operator Date.parse(row['start']), :<=, @today - 100
    assert_operator Date.parse(row['due']), :>=, @today + 100
  end

  def test_data_applies_the_query_filters
    closed = IssueStatus.where(is_closed: true).first
    closed_issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 2, status: closed)
    open_issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 2)

    get :data, params: { project_id: 1, set_filter: 1, f: ['status_id'], op: { status_id: 'c' } }

    ids = response.parsed_body['rows'].pluck('id')
    assert_includes ids, "i#{closed_issue.id}"
    assert_not_includes ids, "i#{open_issue.id}"
  end

  def test_data_does_not_leak_private_issues
    private_issue = Issue.generate!(project: @project, is_private: true, start_date: @today, due_date: @today + 2)
    @request.session[:user_id] = 3 # dlopper: Developer, issues_visibility 'default' roles hide private issues of others
    Role.find(2).update!(issues_visibility: 'default')

    get :data, params: { project_id: 1 }

    assert_response :success
    assert_not_includes response.parsed_body['rows'].pluck('id'), "i#{private_issue.id}"
  end

  def test_data_reports_when_the_row_limit_truncated_the_chart
    3.times { Issue.generate!(project: @project, start_date: @today, due_date: @today + 2) }

    with_settings gantt_items_limit: '2' do
      get :data, params: { project_id: 1 }
    end

    assert response.parsed_body['truncated']
    assert_equal 2, response.parsed_body['max_rows']
  end

  def test_data_with_an_invalid_query_returns_unprocessable_entity
    get :data, params: { project_id: 1, set_filter: 1, f: ['start_date'], op: { start_date: '=' }, v: { start_date: ['x'] } }

    assert_response :unprocessable_entity
    assert response.parsed_body['errors'].any?
  end

  # --------------------------------------------------------- update_dates

  def test_update_dates_saves_the_dates_and_records_the_change_in_the_history
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)

    assert_difference 'Journal.count', 1 do
      put :update_dates, params: { id: issue.id, issue: { start_date: (@today + 2).to_s, due_date: (@today + 9).to_s } }
    end

    assert_response :success
    body = response.parsed_body
    assert body['ok']
    assert_equal (@today + 2).to_s, body['issue']['start_date']
    assert_equal (@today + 9).to_s, body['issue']['due_date']
    issue.reload
    assert_equal @today + 2, issue.start_date
    assert_equal @today + 9, issue.due_date
    journal = issue.journals.last
    assert_equal User.find(2), journal.user
    assert_equal %w[due_date start_date], journal.details.map(&:prop_key).sort
  end

  def test_update_dates_reschedules_following_issues
    first = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    second = Issue.generate!(project: @project, start_date: @today + 6, due_date: @today + 8)
    IssueRelation.create!(issue_from: first, issue_to: second, relation_type: 'precedes')

    put :update_dates, params: { id: first.id, issue: { start_date: (@today + 10).to_s, due_date: (@today + 15).to_s } }

    assert_response :success
    assert_operator second.reload.start_date, :>, @today + 15
  end

  def test_update_dates_refuses_a_start_before_the_preceding_issue_ends
    first = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    second = Issue.generate!(project: @project, start_date: @today + 6, due_date: @today + 8)
    IssueRelation.create!(issue_from: first, issue_to: second, relation_type: 'precedes')
    saved_start = second.reload.start_date # Redmine may have moved it to a working day

    put :update_dates, params: { id: second.id, issue: { start_date: (@today + 1).to_s, due_date: (@today + 3).to_s } }

    assert_response :unprocessable_entity
    assert_match(/preceding issues/, response.parsed_body['errors'].join)
    assert_equal saved_start, second.reload.start_date
  end

  def test_update_dates_with_due_before_start_uses_the_core_validation_message
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)

    put :update_dates, params: { id: issue.id, issue: { start_date: (@today + 5).to_s, due_date: @today.to_s } }

    assert_response :unprocessable_entity
    assert_match(/greater than start date/i, response.parsed_body['errors'].join)
  end

  def test_update_dates_rejects_malformed_dates
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)

    ['nope', '2030-13-45', '', nil].each do |bad|
      put :update_dates, params: { id: issue.id, issue: { start_date: bad, due_date: (@today + 5).to_s } }
      assert_response :unprocessable_entity, "start_date #{bad.inspect} should be rejected"
    end
    put :update_dates, params: { id: issue.id }
    assert_response :unprocessable_entity
    put :update_dates, params: { id: issue.id, issue: 'start_date' }
    assert_response :unprocessable_entity
    put :update_dates, params: { id: issue.id, issue: %w[a b] }
    assert_response :unprocessable_entity
    assert_equal @today, issue.reload.start_date
  end

  def test_update_dates_detects_concurrent_changes_through_lock_version
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    stale_version = issue.lock_version
    issue.update!(subject: 'changed by somebody else')

    put :update_dates, params: { id: issue.id,
                                 issue: { start_date: (@today + 1).to_s, due_date: (@today + 6).to_s,
                                          lock_version: stale_version } }

    assert_response :conflict
    assert_equal @today, issue.reload.start_date
  end

  def test_update_dates_accepts_the_current_lock_version
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)

    put :update_dates, params: { id: issue.id,
                                 issue: { start_date: (@today + 1).to_s, due_date: (@today + 6).to_s,
                                          lock_version: issue.lock_version } }

    assert_response :success
    assert_equal @today + 1, issue.reload.start_date
  end

  def test_update_dates_refuses_dates_that_are_read_only_in_the_workflow
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    WorkflowPermission.create!(role_id: 1, tracker_id: issue.tracker_id, old_status_id: issue.status_id,
                               field_name: 'due_date', rule: 'readonly')

    put :update_dates, params: { id: issue.id, issue: { start_date: @today.to_s, due_date: (@today + 9).to_s } }

    assert_response :forbidden
    assert_equal @today + 5, issue.reload.due_date
  end

  def test_update_dates_allows_changing_only_the_editable_date_when_the_other_one_is_read_only
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    WorkflowPermission.create!(role_id: 1, tracker_id: issue.tracker_id, old_status_id: issue.status_id,
                               field_name: 'start_date', rule: 'readonly')

    put :update_dates, params: { id: issue.id, issue: { start_date: @today.to_s, due_date: (@today + 9).to_s } }

    assert_response :success
    assert_equal @today + 9, issue.reload.due_date
  end

  def test_update_dates_refuses_parents_with_derived_dates
    parent = Issue.generate!(project: @project)
    Issue.generate!(project: @project, parent_issue_id: parent.id, start_date: @today, due_date: @today + 5)

    with_settings parent_issue_dates: 'derived' do
      put :update_dates, params: { id: parent.id, issue: { start_date: (@today + 20).to_s, due_date: (@today + 30).to_s } }
    end

    assert_response :forbidden
    assert_equal @today, parent.reload.start_date
  end

  def test_update_dates_updates_a_derived_parent_when_a_child_moves
    parent = Issue.generate!(project: @project)
    child = Issue.generate!(project: @project, parent_issue_id: parent.id, start_date: @today, due_date: @today + 5)

    with_settings parent_issue_dates: 'derived' do
      put :update_dates, params: { id: child.id, issue: { start_date: (@today + 3).to_s, due_date: (@today + 12).to_s } }
    end

    assert_response :success
    assert_equal [@today + 3, @today + 12], [parent.reload.start_date, parent.due_date]
  end

  def test_update_dates_requires_the_edit_issues_permission
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    Role.find(1).remove_permission!(:edit_issues)

    put :update_dates, params: { id: issue.id, issue: { start_date: (@today + 1).to_s, due_date: (@today + 6).to_s } }

    assert_response :forbidden
    assert_equal @today, issue.reload.start_date
  end

  def test_update_dates_allows_authors_with_only_the_edit_own_issues_permission
    role = Role.find(1)
    role.remove_permission!(:edit_issues)
    role.add_permission!(:edit_own_issues)
    own = Issue.generate!(project: @project, author_id: 2, start_date: @today, due_date: @today + 5)
    foreign = Issue.generate!(project: @project, author_id: 3, start_date: @today, due_date: @today + 5)

    put :update_dates, params: { id: own.id, issue: { start_date: (@today + 1).to_s, due_date: (@today + 6).to_s } }
    assert_response :success
    put :update_dates, params: { id: foreign.id, issue: { start_date: (@today + 1).to_s, due_date: (@today + 6).to_s } }
    assert_response :forbidden
  end

  def test_update_dates_refuses_anonymous_users
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    @request.session[:user_id] = nil
    params = { id: issue.id, issue: { start_date: (@today + 1).to_s, due_date: (@today + 6).to_s } }

    put :update_dates, params: params
    assert_response :redirect # to the login form

    @request.headers['Accept'] = 'application/json' # what the page's fetch() sends
    put :update_dates, params: params
    assert_response :forbidden

    assert_equal @today, issue.reload.start_date
  end

  def test_update_dates_refuses_issues_in_closed_projects
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 5)
    @project.update_column(:status, Project::STATUS_CLOSED)

    put :update_dates, params: { id: issue.id, issue: { start_date: (@today + 1).to_s, due_date: (@today + 6).to_s } }

    assert_response :forbidden
    assert_equal @today, issue.reload.start_date
  end

  def test_update_dates_hides_issues_the_user_cannot_see
    issue = Issue.generate!(project: @project, is_private: true, author_id: 1, start_date: @today, due_date: @today + 5)
    @request.session[:user_id] = 3
    Role.find(2).update!(issues_visibility: 'default')

    put :update_dates, params: { id: issue.id, issue: { start_date: (@today + 1).to_s, due_date: (@today + 6).to_s } }

    assert_response :forbidden
    assert_equal @today, issue.reload.start_date
  end

  def test_update_dates_of_an_unknown_issue_is_not_found
    put :update_dates, params: { id: 999_999, issue: { start_date: @today.to_s, due_date: @today.to_s } }

    assert_response :not_found
  end

  def test_update_dates_sets_both_dates_for_an_issue_that_only_had_one
    issue = Issue.generate!(project: @project, start_date: nil, due_date: @today + 3)

    put :update_dates, params: { id: issue.id, issue: { start_date: (@today + 3).to_s, due_date: (@today + 6).to_s } }

    assert_response :success
    assert_equal [@today + 3, @today + 6], [issue.reload.start_date, issue.due_date]
  end


  # -------------------------------------------------------- restore_dates

  # (Plain params, not `as: :json`: that would set format=json, which Redmine treats as an API
  # request without a session. The page's fetch() to a URL without a suffix has no format.)
  def restore(changes)
    put :restore_dates, params: { changes: changes }
  end

  # One entry of the "changes" list: the dates to put back (nil clears a date).
  def change(issue, start, due, lock_version = nil)
    { id: issue.id, start_date: start&.to_s, due_date: due&.to_s, lock_version: lock_version }
  end

  def test_restore_dates_puts_dates_back_and_records_history_for_each_issue
    a = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)
    b = Issue.generate!(project: @project, start_date: @today + 10, due_date: @today + 12)

    assert_difference 'Journal.count', 2 do
      restore [change(a, @today + 20, @today + 25), change(b, @today + 30, @today + 31)]
    end

    assert_response :success
    assert_equal({ 'ok' => true, 'count' => 2 }, response.parsed_body)
    assert_equal [@today + 20, @today + 25], [a.reload.start_date, a.due_date]
    assert_equal [@today + 30, @today + 31], [b.reload.start_date, b.due_date]
    assert_equal User.find(2), a.journals.last.user
  end

  def test_restore_dates_can_clear_a_date
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)

    restore [change(issue, nil, @today + 3)]

    assert_response :success
    assert_nil issue.reload.start_date
    assert_equal @today + 3, issue.due_date
  end

  def test_restore_dates_skips_changes_that_are_already_in_place
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)

    assert_no_difference 'Journal.count' do
      restore [change(issue, @today, @today + 3)]
    end

    assert_response :success
  end

  def test_restore_dates_is_all_or_nothing
    first = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)
    second = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)

    assert_no_difference 'Journal.count' do
      restore [change(first, @today + 10, @today + 12), change(second, @today + 9, @today + 1)] # due before start
    end

    assert_response :unprocessable_entity
    assert_match(/##{second.id}: .*greater than start date/i, response.parsed_body['errors'].join)
    assert_equal @today, first.reload.start_date
    assert_equal @today, second.reload.start_date
  end

  def test_restore_dates_undoes_a_move_of_a_predecessor_and_its_follower
    first = Issue.generate!(project: @project, start_date: @today, due_date: @today + 4)
    second = Issue.generate!(project: @project, start_date: @today + 5, due_date: @today + 8)
    IssueRelation.create!(issue_from: first, issue_to: second, relation_type: 'precedes')
    original_first = [first.reload.start_date, first.due_date]
    original_second = [second.reload.start_date, second.due_date]

    put :update_dates, params: { id: first.id, issue: { start_date: (@today + 30).to_s, due_date: (@today + 34).to_s } }
    assert_response :success
    assert_not_equal original_second, [second.reload.start_date, second.due_date], 'Redmine should have pushed the follower'

    restore [change(first, *original_first), change(second, *original_second)]

    assert_response :success
    assert_equal original_first, [first.reload.start_date, first.due_date]
    assert_equal original_second, [second.reload.start_date, second.due_date]
  end

  def test_restore_dates_detects_changes_made_in_the_meantime
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)
    other = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)
    stale = issue.lock_version
    issue.update!(subject: 'changed by somebody else')

    assert_no_difference 'Journal.count' do
      restore [change(other, @today + 5, @today + 6, other.lock_version), change(issue, @today + 5, @today + 6, stale)]
    end

    assert_response :conflict
    assert_match(/##{issue.id}|##{issue.id} /, response.parsed_body['errors'].join)
    assert_equal @today, other.reload.start_date, 'nothing may be applied when one issue conflicts'
  end

  def test_restore_dates_accepts_the_current_lock_versions
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)

    restore [change(issue, @today + 5, @today + 6, issue.lock_version)]

    assert_response :success
    assert_equal @today + 5, issue.reload.start_date
  end

  def test_restore_dates_refuses_dates_that_are_read_only_in_the_workflow
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)
    WorkflowPermission.create!(role_id: 1, tracker_id: issue.tracker_id, old_status_id: issue.status_id,
                               field_name: 'due_date', rule: 'readonly')

    restore [change(issue, @today, @today + 9)]

    assert_response :forbidden
    assert_equal @today + 3, issue.reload.due_date
  end

  def test_restore_dates_requires_the_permission_in_every_project_involved
    # jsmith is a Manager of project 5 in the fixtures; make him a Reporter there, without edit_issues.
    Member.find_by!(user_id: 2, project_id: 5).update!(role_ids: [3])
    Role.find(3).remove_permission!(:edit_issues)
    own = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)
    foreign = Issue.generate!(project: Project.find(5), start_date: @today, due_date: @today + 3)

    restore [change(own, @today + 1, @today + 4), change(foreign, @today + 1, @today + 4)]

    assert_response :forbidden
    assert_equal @today, own.reload.start_date, 'nothing may be applied when one issue is refused'
  end

  def test_restore_dates_requires_the_edit_issues_permission
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)
    Role.find(1).remove_permission!(:edit_issues)

    restore [change(issue, @today + 1, @today + 4)]

    assert_response :forbidden
    assert_equal @today, issue.reload.start_date
  end

  def test_restore_dates_hides_issues_the_user_cannot_see
    issue = Issue.generate!(project: @project, is_private: true, author_id: 1, start_date: @today, due_date: @today + 3)
    @request.session[:user_id] = 3
    Role.find(2).update!(issues_visibility: 'default')

    restore [change(issue, @today + 1, @today + 4)]

    assert_response :not_found
    assert_equal @today, issue.reload.start_date
  end

  def test_restore_dates_of_an_unknown_issue_is_not_found
    restore [{ id: 999_999, start_date: @today.to_s, due_date: @today.to_s }]

    assert_response :not_found
  end

  def test_restore_dates_refuses_anonymous_users
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)
    @request.session[:user_id] = nil
    @request.headers['Accept'] = 'application/json'

    restore [change(issue, @today + 1, @today + 4)]

    assert_response :forbidden
    assert_equal @today, issue.reload.start_date
  end

  def test_restore_dates_rejects_malformed_payloads
    issue = Issue.generate!(project: @project, start_date: @today, due_date: @today + 3)
    good = change(issue, @today + 1, @today + 4)

    payloads = [
      nil, [], 'nope', { id: issue.id },
      [good, good], # the same issue twice
      [{ id: 'x', start_date: '2030-01-01', due_date: '2030-01-02' }],
      [{ id: issue.id, start_date: 'nope', due_date: '2030-01-02' }],
      [{ id: issue.id, start_date: '2030-13-45', due_date: '2030-01-02' }],
      [{ id: issue.id, start_date: '2030-01-01', due_date: '2030-01-02', lock_version: 'x' }],
      ['not a hash']
    ]
    payloads.each do |payload|
      put :restore_dates, params: { changes: payload }
      assert_response :unprocessable_entity, "#{payload.inspect} should be rejected"
    end
    assert_equal @today, issue.reload.start_date
  end

  def test_restore_dates_limits_the_size_of_a_batch
    changes = Array.new(VisGanttsController::MAX_RESTORE + 1) { |i| { id: 1_000_000 + i, start_date: nil, due_date: nil } }

    restore changes

    assert_response :unprocessable_entity
  end

  def test_restore_dates_reschedules_derived_parents_as_usual
    parent = Issue.generate!(project: @project)
    child = Issue.generate!(project: @project, parent_issue_id: parent.id, start_date: @today, due_date: @today + 5)

    with_settings parent_issue_dates: 'derived' do
      restore [change(child, @today + 3, @today + 12)]
    end

    assert_response :success
    assert_equal [@today + 3, @today + 12], [parent.reload.start_date, parent.due_date]
  end

  # ----------------------------------------------------------------- menus

  def test_the_global_view_is_in_the_application_menu_and_not_in_the_top_menu
    get :show

    assert_response :success
    assert_select '#main-menu a.vis-gantt.selected', 1
    assert_select '#top-menu a', text: /Gantt/, count: 0
  end

  def test_the_project_view_has_a_project_menu_tab
    get :show, params: { project_id: 1 }

    assert_select '#main-menu a.vis-gantt.selected', 1
  end

  def test_the_menu_entries_follow_the_view_gantt_permission
    Role.find(1).remove_permission!(:view_gantt)
    Role.non_member.remove_permission!(:view_gantt)
    Role.anonymous.remove_permission!(:view_gantt)

    get :show, params: { project_id: 1 }

    assert_response :forbidden
  end

  # ----------------------------------------------------------- permissions

  def test_assets_available_when_propshaft_knows_all_the_plugin_files
    assert RedmineVisGantt.assets_available?
  end

  def test_assets_not_available_when_the_compiled_assets_lack_a_plugin_file
    resolver = Rails.application.assets.resolver
    resolver.stubs(:resolve).returns('/assets/x.js')
    resolver.stubs(:resolve).with('plugin_assets/redmine_vis_gantt/vis_gantt.js').returns(nil)

    assert_not RedmineVisGantt.assets_available?
  end

  def test_assets_check_does_not_hide_the_chart_when_it_cannot_decide
    Rails.application.assets.resolver.stubs(:resolve).raises(StandardError, 'boom')

    assert RedmineVisGantt.assets_available?
  end

  def test_the_plugin_attaches_its_actions_to_existing_permissions_only_once
    before = Redmine::AccessControl.permission(:view_gantt).actions.dup

    2.times { RedmineVisGantt.extend_permissions }

    assert_equal before, Redmine::AccessControl.permission(:view_gantt).actions
    assert_includes Redmine::AccessControl.allowed_actions(:view_gantt), 'vis_gantts/show'
    assert_includes Redmine::AccessControl.allowed_actions(:view_gantt), 'vis_gantts/data'
    assert_includes Redmine::AccessControl.allowed_actions(:edit_issues), 'vis_gantts/update_dates'
    assert_includes Redmine::AccessControl.allowed_actions(:edit_own_issues), 'vis_gantts/update_dates'
    assert_includes Redmine::AccessControl.allowed_actions(:edit_issues), 'vis_gantts/restore_dates'
    assert_includes Redmine::AccessControl.allowed_actions(:edit_own_issues), 'vis_gantts/restore_dates'
    assert_not_includes Redmine::AccessControl.allowed_actions(:view_gantt), 'vis_gantts/restore_dates'
    assert_not_includes Redmine::AccessControl.allowed_actions(:view_gantt), 'vis_gantts/update_dates'
  end
end
