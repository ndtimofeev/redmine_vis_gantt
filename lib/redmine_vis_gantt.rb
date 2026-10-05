# frozen_string_literal: true

module RedmineVisGantt
  # The plugin does not introduce permissions of its own: whoever may see the
  # built-in Gantt may see this one, and whoever may edit issues (all of them,
  # or just their own, like on the issue form) may move their dates on the
  # chart. The controller actions are attached to those existing permissions
  # instead; which issues the user may really change is decided per issue by
  # Issue#safe_attributes.
  PERMISSION_ACTIONS = {
    view_gantt: %w[vis_gantts/show vis_gantts/data],
    edit_issues: %w[vis_gantts/update_dates vis_gantts/restore_dates],
    edit_own_issues: %w[vis_gantts/update_dates vis_gantts/restore_dates]
  }.freeze

  def self.extend_permissions
    PERMISSION_ACTIONS.each do |permission_name, actions|
      permission = Redmine::AccessControl.permission(permission_name)
      next unless permission

      actions.each do |action|
        permission.actions << action unless permission.actions.include?(action)
      end
    end
  end

  # Logical paths (as Propshaft knows them) of the files the page needs.
  ASSETS = %w[
    plugin_assets/redmine_vis_gantt/vis-timeline-graph2d.min.js
    plugin_assets/redmine_vis_gantt/vis_gantt.js
    plugin_assets/redmine_vis_gantt/vis_gantt.css
  ].freeze

  # False when Redmine's compiled assets do not contain the plugin's files.
  #
  # In production Redmine serves the precompiled public/assets. It recompiles at
  # startup only if some asset file is newer than the manifest, so plugin files
  # that are older than the manifest (assets precompiled after the plugin was
  # copied in, files extracted from an archive with their original timestamps,
  # a Docker image built before the plugin was added, ...) are silently left out
  # and their URLs answer 404. The page would then show nothing but its text.
  def self.assets_available?
    resolver = Rails.application.assets.resolver
    ASSETS.all? { |path| resolver.resolve(path) }
  rescue StandardError
    true # cannot tell: do not hide the chart because of a failed check
  end
end
