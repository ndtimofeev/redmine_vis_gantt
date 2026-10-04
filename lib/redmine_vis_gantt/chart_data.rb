# frozen_string_literal: true

module RedmineVisGantt
  # Turns what Redmine's own Gantt helper has selected (query filters,
  # visibility, row limit, project/version/issue ordering) into a flat list of
  # rows for the browser. Rows come in the same order the built-in Gantt draws
  # them; `parent` and `depth` let the client collapse and indent them.
  #
  # Dates are inclusive, like everywhere in Redmine: a bar covers `start`
  # through `due`.
  class ChartData
    include Redmine::I18n

    # +gantt+: a Redmine::Helpers::Gantt with project and query assigned.
    # +urls+:  anything that responds to project_path/version_path/issue_path
    #          (the controller), so sub-URI deployments get correct links.
    def initialize(gantt, urls:, user: User.current)
      @gantt = gantt
      @urls = urls
      @user = user
      @today = user.today
      @rows = []
      @rows_by_id = {}
      @editable_cache = {}
    end

    def as_json(*)
      build
      {
        today: @today,
        truncated: truncated?,
        max_rows: @gantt.max_rows,
        rows: @rows,
        relations: relations
      }
    end

    private

    def build
      return if @built

      @built = true
      project_stack = []
      Project.project_tree(@gantt.projects) do |project, level|
        project_stack = project_stack.first(level)
        row = add_project(project, project_stack.last)
        project_stack << row
        add_project_content(project, row)
      end
    end

    def truncated?
      @gantt.max_rows.present? && @gantt.issues.size >= @gantt.max_rows
    end

    # Same relation types as the built-in Gantt draws, restricted to rows we
    # actually emit.
    def relations
      @gantt.relations.values.flatten.filter_map do |relation|
        from = "i#{relation.issue_from_id}"
        to = "i#{relation.issue_to_id}"
        next unless @rows_by_id.key?(from) && @rows_by_id.key?(to)

        { from: from, to: to, type: relation.relation_type }
      end
    end

    def add_project_content(project, project_row)
      add_issues(@gantt.project_issues(project).select { |i| i.fixed_version_id.nil? }, project_row)

      versions = @gantt.project_versions(project).dup
      Redmine::Helpers::Gantt.sort_versions!(versions)
      versions.each do |version|
        version_row = add_version(version, project, project_row)
        add_issues(@gantt.version_issues(project, version), version_row)
      end
    end

    def add_project(project, parent_row)
      add_row(
        id: "p#{project.id}", kind: 'project', parent_row: parent_row,
        name: project.name, url: @urls.project_path(project)
      )
    end

    def add_version(version, project, parent_row)
      row = add_row(
        # A shared version can show up under several projects.
        id: "v#{version.id}p#{project.id}", kind: 'version', parent_row: parent_row,
        name: version.to_s_with_project, url: @urls.version_path(version),
        closed: !version.open?, overdue: version.overdue?
      )
      start = version.start_date
      due = version.due_date
      if due
        start ||= due
        start, due = due, start if due < start
        completed = version.visible_fixed_issues.completed_percent.to_f.round
        row.merge!(start: start, due: due, done_ratio: completed, progress: completed / 100.0)
        add_late_to(row)
        extend_projects(row, start, due)
      end
      row
    end

    # Issues arrive sorted like the built-in Gantt sorts them; an issue is
    # nested below the closest preceding issue it descends from.
    def add_issues(issues, parent_row)
      issues = issues.dup
      Redmine::Helpers::Gantt.sort_issues!(issues)
      stack = []
      issues.each do |issue|
        stack.pop while stack.any? && !issue.is_descendant_of?(stack.last.first)
        row = add_issue(issue, stack.empty? ? parent_row : stack.last.last)
        stack << [issue, row] unless issue.leaf?
      end
    end

    def add_issue(issue, parent_row)
      row = add_row(
        id: "i#{issue.id}", kind: 'issue', parent_row: parent_row,
        issue_id: issue.id, tracker: issue.tracker.name, name: issue.subject,
        url: @urls.issue_path(issue), assignee: issue.assigned_to&.name,
        status: issue.status.name, closed: issue.closed?, overdue: issue.overdue?,
        lock_version: issue.lock_version, derived: issue.dates_derived?,
        editable: editable_flags(issue)
      )
      row[:done_ratio] = issue.done_ratio unless issue.disabled_core_fields.include?('done_ratio')

      # The built-in Gantt draws nothing unless both dates are known. We also
      # draw issues with just one of them (as a one-day bar) so that dates can
      # be set by dragging.
      start = issue.start_date
      due = issue.due_before
      return row unless start || due

      row[:due_inherited] = issue.due_date.nil? && due.present?
      start ||= due
      due ||= start
      due = start if due < start
      row.merge!(start: start, due: due)
      if row[:done_ratio]
        row[:progress] = row[:done_ratio] / 100.0
        add_late_to(row)
      end
      extend_projects(row, start, due)
      row
    end

    # The part of a bar that is behind schedule: from the done ratio up to
    # today (or the end of the bar), like the red part of the built-in Gantt.
    def add_late_to(row)
      total = (row[:due] - row[:start] + 1).to_f
      progress_offset = total * row[:progress]
      return unless progress_offset <= (@today - row[:start])

      late_to = ([@today, row[:due]].min + 1 - row[:start]) / total
      row[:late_to] = [late_to, 1.0].min if late_to > row[:progress]
    end

    # Project rows summarize everything below them.
    def extend_projects(row, start, due)
      parent = @rows_by_id[row[:parent]]
      while parent
        if parent[:kind] == 'project'
          parent[:start] = [parent[:start], start].compact.min
          parent[:due] = [parent[:due], due].compact.max
        end
        parent = @rows_by_id[parent[:parent]]
      end
    end

    # Whether the current user may change the dates, per field. Depends on the
    # workflow (read-only fields), the tracker, the permission and on whether the
    # dates are derived from subtasks, so it is computed once per combination
    # instead of once per issue.
    def editable_flags(issue)
      key = [issue.project_id, issue.tracker_id, issue.status_id,
             issue.author_id == @user.id, issue.leaf?]
      @editable_cache[key] ||= {
        start: issue.safe_attribute?('start_date'),
        due: issue.safe_attribute?('due_date')
      }
    end

    def add_row(attributes)
      parent_row = attributes.delete(:parent_row)
      row = attributes.merge(
        parent: parent_row&.fetch(:id),
        depth: parent_row ? parent_row[:depth] + 1 : 0
      )
      @rows << row
      @rows_by_id[row[:id]] = row
      row
    end
  end
end
