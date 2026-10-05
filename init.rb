# frozen_string_literal: true

Redmine::Plugin.register :redmine_vis_gantt do
  name 'Interactive Gantt'
  description 'A Gantt chart on top of vis-timeline: drag bars to reschedule issues, undo and redo'
  version '0.1.0'
  requires_redmine version_or_higher: '6.0.0'

  # Same visibility rules as the built-in Gantt (the :gantt module and the
  # :view_gantt permission), see RedmineVisGantt.extend_permissions below.
  menu :project_menu, :vis_gantt,
       { controller: 'vis_gantts', action: 'show' },
       caption: :label_vis_gantt, param: :project_id,
       after: :gantt, permission: :view_gantt

  # The all-projects view. Redmine shows the application menu (Issues, Spent time,
  # Gantt, Calendar, ...) on pages that do not belong to a project, which is where
  # the built-in Gantt's global view lives too, so this sits right after it.
  menu :application_menu, :vis_gantt,
       { controller: 'vis_gantts', action: 'show' },
       caption: :label_vis_gantt, after: :gantt,
       if: proc {
         User.current.allowed_to?(:view_gantt, nil, global: true) &&
           EnabledModule.exists?(project: Project.visible, name: :gantt)
       }
end

RedmineVisGantt.extend_permissions
