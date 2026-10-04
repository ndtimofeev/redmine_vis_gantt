# DEVELOPMENT ONLY. Demo data for trying the vis-timeline Gantt: two projects, versions, a task hierarchy,
# relations, an overdue and a closed issue, and users with different roles. It resets the admin password
# to "adminadmin1" and creates users dev/rep (password "password123").
#
#   RAILS_ENV=development bundle exec rails runner plugins/redmine_vis_gantt/dev/seed_demo.rb
today = Date.today
admin = User.find_by_login('admin')
admin.password = admin.password_confirmation = 'adminadmin1'
admin.must_change_passwd = false
admin.save!

Setting.default_language = 'en'
Setting.rest_api_enabled = '0'

def mkuser(login, role, project)
  u = User.find_by_login(login) || User.new(login: login, firstname: login.capitalize, lastname: 'Test', mail: "#{login}@example.net")
  u.password = u.password_confirmation = 'password123'
  u.must_change_passwd = false
  u.language = 'en'
  u.save!
  Member.where(user_id: u.id, project_id: project.id).destroy_all
  Member.create!(user: u, project: project, roles: [role])
  u
end

proj = Project.find_by_identifier('demo') || Project.create!(
  name: 'Demo Project', identifier: 'demo', is_public: true,
  enabled_module_names: %w[issue_tracking gantt time_tracking calendar],
  tracker_ids: Tracker.pluck(:id)
)
sub = Project.find_by_identifier('demo-sub') || Project.create!(
  name: 'Demo Subproject', identifier: 'demo-sub', is_public: true, parent: proj,
  enabled_module_names: %w[issue_tracking gantt], tracker_ids: Tracker.pluck(:id)
)
dev = mkuser('dev', Role.find_by_name('Developer'), proj)
rep = mkuser('rep', Role.find_by_name('Reporter'), proj)
Member.where(user_id: admin.id, project_id: proj.id).first || Member.create!(user: admin, project: proj, roles: [Role.find_by_name('Manager')])

Member.where(user_id: dev.id, project_id: sub.id).first || Member.create!(user: dev, project: sub, roles: [Role.find_by_name('Developer')])

v1 = Version.find_by(project_id: proj.id, name: '1.0') || Version.create!(project: proj, name: '1.0', effective_date: today + 75, status: 'open')
v2 = Version.find_by(project_id: proj.id, name: '2.0') || Version.create!(project: proj, name: '2.0', effective_date: today + 150, status: 'open')

bug = Tracker.find_by_name('Bug'); feat = Tracker.find_by_name('Feature'); sup = Tracker.find_by_name('Support')
st_new = IssueStatus.find_by_name('New'); st_prog = IssueStatus.find_by_name('In Progress'); st_closed = IssueStatus.find_by_name('Closed')
prio = IssuePriority.default || IssuePriority.first

Issue.where(project_id: [proj.id, sub.id]).destroy_all
def mk(project, tracker, subject, start = nil, due = nil, opts = {})
  i = Issue.new(project: project, tracker: tracker, subject: subject, author: User.find_by_login('admin'),
                priority: IssuePriority.default || IssuePriority.first, status: opts[:status] || IssueStatus.find_by_name('New'))
  i.start_date = start
  i.due_date = due
  i.fixed_version = opts[:version]
  i.assigned_to = opts[:assignee]
  i.done_ratio = opts[:done] if opts[:done]
  i.parent_issue_id = opts[:parent].id if opts[:parent]
  i.save!
  i
end

design  = mk(proj, feat, 'Design the module', today - 20, today - 6, version: v1, assignee: dev, done: 100, status: st_closed)
backend = mk(proj, feat, 'Implement backend', today - 5, today + 14, version: v1, assignee: dev, done: 40, status: st_prog)
ui      = mk(proj, feat, 'Implement UI', today + 15, today + 35, version: v1, assignee: admin, done: 0)
test    = mk(proj, sup, 'Acceptance testing', today + 36, today + 50, version: v1, assignee: dev)
parent  = mk(proj, feat, 'Documentation', today + 5, today + 30, version: v1)
c1      = mk(proj, feat, 'Write user guide', today + 5, today + 18, version: v1, parent: parent, assignee: dev, done: 20)
c2      = mk(proj, feat, 'Write admin guide', today + 12, today + 30, version: v1, parent: parent)
late    = mk(proj, bug, 'Overdue bugfix', today - 15, today - 2, assignee: dev, done: 30, status: st_prog)
nodate  = mk(proj, bug, 'Issue without dates')
dueonly = mk(proj, bug, 'Issue with only a due date', nil, today + 9)
rel2    = mk(proj, feat, 'Plan version 2.0', today + 40, today + 100, version: v2, assignee: admin)
subiss  = mk(sub, feat, 'Subproject task', today - 3, today + 25, assignee: dev, done: 10)

[[design, backend], [backend, ui], [ui, test]].each do |a, b|
  IssueRelation.create!(issue_from: a, issue_to: b, relation_type: 'precedes', delay: 0) rescue puts("relation: #{$!.message}")
end
IssueRelation.create!(issue_from: late, issue_to: backend, relation_type: 'blocks') rescue puts("relation: #{$!.message}")

puts "projects=#{Project.count} issues=#{Issue.count} relations=#{IssueRelation.count}"
puts "today=#{today}; parent_issue_dates=#{Setting.parent_issue_dates}"
