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
    edit_issues: %w[vis_gantts/update_dates],
    edit_own_issues: %w[vis_gantts/update_dates]
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
end
