# frozen_string_literal: true

class VisGanttsController < ApplicationController
  menu_item :vis_gantt

  before_action :find_optional_project, only: %i[show data]
  before_action :find_issue_for_update, only: :update_dates

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
