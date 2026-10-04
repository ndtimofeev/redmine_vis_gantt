# frozen_string_literal: true

Redmine::Plugin.register :redmine_vis_gantt do
  name 'Redmine vis-timeline Gantt'
  description 'Experimental Gantt chart on top of vis-timeline with drag-and-drop rescheduling'
  version '0.1.0'
  requires_redmine version_or_higher: '6.0.0'

  # Same visibility rules as the built-in Gantt (the :gantt module and the
  # :view_gantt permission), see RedmineVisGantt.extend_permissions below.
  menu :project_menu, :vis_gantt,
       { controller: 'vis_gantts', action: 'show' },
       caption: :label_vis_gantt, param: :project_id,
       after: :gantt, permission: :view_gantt

  menu :top_menu, :vis_gantt,
       { controller: 'vis_gantts', action: 'show' },
       caption: :label_vis_gantt, after: :gantt,
       if: proc {
         User.current.allowed_to?(:view_gantt, nil, global: true) &&
           EnabledModule.exists?(project: Project.visible, name: :gantt)
       }
end

RedmineVisGantt.extend_permissions
