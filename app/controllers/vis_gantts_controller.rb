# frozen_string_literal: true

class VisGanttsController < ApplicationController
  # Most issues one restore_dates call accepts: undoing a drag touches the moved
  # issue plus whatever Redmine rescheduled because of it.
  MAX_RESTORE = 100
  ISO_DATE = /\A\d{4}-\d{2}-\d{2}\z/

  # Raised inside restore_dates' transaction to roll everything back.
  class RestoreFailed < StandardError
    attr_reader :status, :messages

    def initialize(status, messages)
      @status = status
      @messages = Array(messages)
      super(@messages.join(' '))
    end
  end

  menu_item :vis_gantt

  before_action :find_optional_project, only: %i[show data]
  before_action :find_issue_for_update, only: :update_dates
  before_action :require_login, only: :restore_dates

  rescue_from Query::StatementInvalid, with: :query_statement_invalid

  helper :issues
  helper :projects
  helper :queries
  include QueriesHelper

  def show
    build_chart
  end

  # The chart as JSON, used to refresh the page after a change. Not a ".json"
  # URL on purpose, see config/routes.rb.
  def data
    build_chart
    if @chart
      render json: @chart
    else
      render json: { errors: @query.errors.full_messages }, status: :unprocessable_entity
    end
  end

  # Moves and/or resizes an issue. Goes through the same safe_attributes
  # machinery as the regular issue form, so permissions, workflow read-only
  # fields, validations, relation rescheduling, parent date derivation, the
  # history entry and notifications all behave exactly as when editing the
  # issue by hand.
  def update_dates
    requested = requested_dates
    return render_errors([l(:error_vis_gantt_invalid_dates)], :unprocessable_entity) unless requested

    @issue.init_journal(User.current)
    attributes = requested.dup
    # Refuse to overwrite changes somebody else made since the chart was drawn.
    attributes['lock_version'] = params[:issue][:lock_version] if params[:issue][:lock_version].present?
    @issue.safe_attributes = attributes

    # safe_attributes silently drops what the user may not edit.
    refused = requested.reject { |attribute, value| @issue.public_send(attribute)&.iso8601 == value }
    if refused.any?
      return render_errors([l(:error_vis_gantt_dates_not_editable)], :forbidden)
    end

    if @issue.save
      render json: { ok: true, issue: issue_json(@issue) }
    else
      render_errors(@issue.errors.full_messages, :unprocessable_entity)
    end
  rescue ActiveRecord::StaleObjectError
    render_errors([l(:error_vis_gantt_stale_issue)], :conflict)
  end

  # Puts the dates of several issues back (undo / redo), in the order given, as one
  # unit: either every issue gets its dates or none does. Each issue goes through
  # the same safe_attributes path as update_dates (so permissions, workflow,
  # validations and the history entry behave as on the issue form); a change that is
  # a no-op is skipped. Callers send the moved issue first, then the issues Redmine
  # rescheduled because of it, so that every intermediate state is valid.
  #
  # An optional lock_version per issue guards against changes made by somebody else
  # since. It is checked for all issues before anything is written, because
  # rescheduling inside the batch bumps the lock_version of the issues it touches.
  def restore_dates
    changes = requested_changes
    return render_errors([l(:error_vis_gantt_invalid_dates)], :unprocessable_entity) unless changes
    return render_errors([l(:error_vis_gantt_too_many)], :unprocessable_entity) if changes.size > MAX_RESTORE

    Issue.transaction do
      issues = changes.map { |change| issue_for_restore(change) }
      issues.zip(changes) { |issue, change| restore_issue_dates(issue, change) }
    end
    render json: { ok: true, count: changes.size }
  rescue RestoreFailed => e
    render_errors(e.messages, e.status)
  end

  private

  def build_chart
    @gantt = Redmine::Helpers::Gantt.new({})
    @gantt.project = @project
    retrieve_query
    @query.group_by = nil
    return unless @query.valid?

    @gantt.query = @query
    @chart = RedmineVisGantt::ChartData.new(@gantt, urls: self)
  end

  def find_issue_for_update
    @issue = Issue.find(params[:id])
    raise ::Unauthorized unless @issue.visible?

    @project = @issue.project
    authorize
  rescue ActiveRecord::RecordNotFound
    render_404
  end

  def requested_dates
    issue_params = params[:issue]
    return unless issue_params.is_a?(ActionController::Parameters)

    dates = %w[start_date due_date].index_with { |name| issue_params[name].to_s }
    return unless dates.values.all? { |value| value.match?(/\A\d{4}-\d{2}-\d{2}\z/) && valid_date?(value) }

    dates
  end

  # [{'id' => 1, 'start_date' => '2030-01-02' | nil, 'due_date' => ..., 'lock_version' => 3 | nil}, ...]
  # or nil when the payload is malformed.
  def requested_changes
    list = params[:changes]
    return unless list.is_a?(Array) && list.any?

    changes = list.map { |item| parse_change(item) }
    return if changes.any?(&:nil?) || changes.map { |change| change['id'] }.uniq.size != changes.size

    changes
  end

  def parse_change(item)
    return unless item.is_a?(ActionController::Parameters)
    return unless item[:id].to_s.match?(/\A\d+\z/)

    dates = %w[start_date due_date].to_h { |name| [name, item[name].presence&.to_s] }
    return unless dates.values.all? { |value| value.nil? || (value.match?(ISO_DATE) && valid_date?(value)) }

    lock_version = item[:lock_version].presence&.to_s
    return if lock_version && !lock_version.match?(/\A\d+\z/)

    dates.merge('id' => item[:id].to_s.to_i, 'lock_version' => lock_version&.to_i)
  end

  # The issue, after checking visibility, permission and (if given) lock_version.
  def issue_for_restore(change)
    issue = Issue.find_by(id: change['id'])
    unless issue&.visible?
      raise RestoreFailed.new(:not_found, l(:error_vis_gantt_issue_not_found, id: change['id']))
    end

    unless User.current.allowed_to?({ controller: 'vis_gantts', action: 'restore_dates' }, issue.project)
      raise RestoreFailed.new(:forbidden, "##{issue.id}: #{l(:error_vis_gantt_dates_not_editable)}")
    end

    if change['lock_version'] && issue.lock_version != change['lock_version']
      raise RestoreFailed.new(:conflict, l(:error_vis_gantt_stale_issue_n, id: issue.id))
    end

    issue
  end

  def restore_issue_dates(issue, change)
    issue.reload # an earlier change in the batch may have rescheduled it
    return if dates_match?(issue, change)

    issue.init_journal(User.current)
    issue.safe_attributes = { 'start_date' => change['start_date'].to_s, 'due_date' => change['due_date'].to_s }
    # safe_attributes silently drops what the user may not edit.
    unless dates_match?(issue, change)
      raise RestoreFailed.new(:forbidden, "##{issue.id}: #{l(:error_vis_gantt_dates_not_editable)}")
    end
    return if issue.save

    raise RestoreFailed.new(:unprocessable_entity, issue.errors.full_messages.map { |message| "##{issue.id}: #{message}" })
  rescue ActiveRecord::StaleObjectError
    raise RestoreFailed.new(:conflict, l(:error_vis_gantt_stale_issue_n, id: issue.id))
  end

  def dates_match?(issue, change)
    issue.start_date&.iso8601 == change['start_date'] && issue.due_date&.iso8601 == change['due_date']
  end

  def valid_date?(value)
    Date.iso8601(value)
    true
  rescue ArgumentError
    false
  end

  def issue_json(issue)
    {
      id: issue.id, lock_version: issue.lock_version,
      start_date: issue.start_date, due_date: issue.due_date
    }
  end

  def render_errors(messages, status)
    render json: { errors: messages }, status: status
  end
end
