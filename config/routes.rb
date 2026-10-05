# frozen_string_literal: true

# NB: the data and update endpoints deliberately have no ".json" suffix.
# Redmine treats *.json requests as API requests and ignores the session for
# them, but this page is driven by the logged-in browser session.
get '/projects/:project_id/vis_gantt/data', to: 'vis_gantts#data', as: 'project_vis_gantt_data'
get '/projects/:project_id/vis_gantt', to: 'vis_gantts#show', as: 'project_vis_gantt'
get '/vis_gantt/data', to: 'vis_gantts#data', as: 'vis_gantt_data'
get '/vis_gantt', to: 'vis_gantts#show', as: 'vis_gantt'
put '/vis_gantt/issues/:id/dates', to: 'vis_gantts#update_dates', as: 'vis_gantt_issue_dates',
                                   constraints: { id: /\d+/ }
put '/vis_gantt/restore_dates', to: 'vis_gantts#restore_dates', as: 'vis_gantt_restore_dates'
