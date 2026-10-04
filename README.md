# redmine_vis_gantt

An experimental Gantt chart for Redmine built on [vis-timeline](https://visjs.github.io/vis-timeline/).
It sits **next to** the built-in Gantt (nothing is replaced), shows the same issues, and lets you
**reschedule issues with the mouse**: drag a bar to move an issue, drag its left or right edge to
change the start or due date.

![screenshot](docs/screenshot.png)

The point of the prototype is to see how an interactive timeline feels in Redmine and to find out what
it takes to build on it (for example a resource/equipment Gantt where the rows are resources and the
bars are bookings).

## What you get

* Same rows as the built-in Gantt, in the same order: projects, subprojects, versions, issues, issue
  hierarchy. The page reuses `Redmine::Helpers::Gantt` for the selection, so query filters, issue
  visibility, saved queries and the "maximum number of items" setting behave exactly as they do there.
* Bars show the done ratio and the part that is behind schedule (same colours as the built-in Gantt);
  parent issues and projects are drawn as thin summary bars; closed issues are faded.
* **Drag to reschedule.** Move a bar, or resize it from either end. Bars snap to whole days. The change
  is saved immediately and the chart reloads, because Redmine may have moved other issues (see below).
* "Blocks" and "precedes" relations are drawn as arrows.
* Collapse/expand branches, zoom (buttons or Ctrl + wheel), "Today", "Show everything", double-click a
  bar to open the issue, tooltips with status, assignee and dates.
* Texts in English and Russian; the time axis follows the user's language.
* A top-menu entry and a project-menu tab "Gantt (vis-timeline)". URLs: `/vis_gantt` and
  `/projects/:id/vis_gantt`.

## How saving works

A drop sends `PUT /vis_gantt/issues/:id/dates` with the new dates and the issue's `lock_version`. The
controller loads the issue, calls `init_journal` and assigns the dates through `safe_attributes=`, i.e.
through exactly the code path of the issue edit form. So, without any extra code here:

* permissions and workflow "read-only" fields are respected (a field the user may not edit is refused
  with a 403 and the bar jumps back);
* validations apply (for example a successor cannot start before its predecessor ends);
* **following issues are rescheduled** by Redmine, and **parents with derived dates** follow their
  children, which is why the chart reloads after every successful save;
* a history entry is written and the usual notifications are sent;
* a concurrent change by somebody else is detected through `lock_version` (409, chart refreshed).

Parents whose dates are derived from their subtasks are not draggable.

## Permissions

The plugin adds none. Whoever may see the built-in Gantt (`view_gantt`, module "Gantt") may see this
one, and whoever has `edit_issues` or `edit_own_issues` may move dates (per issue, as on the edit form).
The plugin attaches its controller actions to those existing permissions in `lib/redmine_vis_gantt.rb`.

## Installation

```
cd /path/to/redmine/plugins
cp -r /path/to/redmine_vis_gantt .        # the directory must be named exactly redmine_vis_gantt
cd ..
# production only: Redmine serves precompiled assets, so compile the plugin's too
RAILS_ENV=production bundle exec rake assets:precompile   # add RAILS_RELATIVE_URL_ROOT=/sub-uri if Redmine runs under a sub-URI
# restart Redmine
```

Run the command as the user Redmine runs as (it writes to `public/assets`), e.g. `sudo -u redmine …`.
`bin/rails assets:precompile`, as written in Redmine's own `doc/INSTALL`, is equivalent, but fails with
`Permission denied` if `bin/rails` has lost its executable bit (Redmine unpacked from a zip, a `noexec`
mount); `bundle exec rake …` and `ruby bin/rails …` do not need that bit.

No migrations and no gems. The `assets:precompile` step is the one Redmine's own `doc/INSTALL` and
`doc/UPGRADING` prescribe; **repeat it whenever the plugin's JavaScript or CSS changes**, and see
*Troubleshooting* below if you skip it. In development mode nothing but a restart is needed.

Tested on **Redmine 6.1.5** (Rails 7.2) and **Redmine 7.0.2** (Rails 8.1) with Ruby 3.3 and SQLite.
The plugin declares `requires_redmine version_or_higher: '6.0.0'`.

## Troubleshooting

### The tab shows only the hint text and nothing else (no toolbar, no chart)

The page is rendered by Redmine, the chart by the plugin's JavaScript. If that JavaScript is not loaded,
all you see is the text. The plugin now says so instead of staying silent:

* **A red box "The chart cannot be shown: the plugin's JavaScript and CSS files are not part of Redmine's
  compiled assets"**: run `RAILS_ENV=production bundle exec rake assets:precompile` in the Redmine directory and
  restart Redmine.
  *Why it happens:* in production Redmine serves the precompiled `public/assets`. At startup it recompiles
  only if some asset file is **newer than the manifest** (`public/assets/.manifest.json`; see
  `manifest_outdated?` in Redmine's `config/initializers/10-patches.rb`). Plugin files that are older
  than the manifest are silently left out, and their URLs answer 404. Typical causes: the plugin was added
  to a Docker image or a server whose assets had been precompiled earlier, or the files were extracted from
  an archive with their original timestamps. (`touch`-ing the plugin's asset files and restarting works as
  well, but precompiling is the documented way.)
* **The text "Loading the chart…" stays on the page**: the plugin's own script did not load. Open the browser
  developer tools (F12) → *Network*, reload, and look for `vis_gantt-….js` / `vis-timeline-graph2d…js`
  with status 404 (same remedy as above), blocked by a Content-Security-Policy, or served from a stale
  cache of a reverse proxy.
* **A red box "The vis-timeline library did not load"**: the library file is missing or blocked; same checks.
* **A red box "The chart script did not start: …"** with a reason: a JavaScript error while starting up. The
  full stack trace is in the browser console; please report it together with the browser version.

Also check that the plugin directory is named `redmine_vis_gantt` (not `redmine_vis_gantt-main`, and not
nested one level deeper) and that Redmine was restarted after copying it.

## Layout

```
init.rb                               registration, menu entries, permission wiring
config/routes.rb                      page, data endpoint, date update endpoint
app/controllers/vis_gantts_controller.rb
app/views/vis_gantts/show.html.erb    filters form + chart container (config as a data attribute)
lib/redmine_vis_gantt/chart_data.rb   Gantt helper output -> flat list of rows for the browser
assets/javascripts/vis_gantt.js       rows -> vis-timeline groups/items, drag handling, relation arrows
assets/javascripts/vis-timeline-graph2d.min.js   vendored vis-timeline 8.5.4 (includes its CSS)
test/                                 functional tests (Redmine's test framework)
dev/                                  demo data and browser scenarios (development only)
licenses/vis-timeline/                vis-timeline licenses (Apache-2.0 OR MIT)
```

Notes for hacking on it:

* The data and update endpoints deliberately have **no `.json` suffix**. Redmine treats `*.json`
  requests as API requests and ignores the browser session for them.
* Dates are inclusive, as everywhere in Redmine; the JS turns a due date into an exclusive end
  (`due + 1 day`) for vis-timeline and back.
* Each row is a vis-timeline *group* (the left column) with at most one *item* (the bar). Collapsing
  toggles the groups' `visible` flag; the hierarchy comes from `parent`/`depth` in the data.
* vis-timeline's standalone bundle injects its own CSS when the script runs, i.e. after the plugin
  stylesheet, so rules overriding it must be more specific (they are prefixed with `#vis-gantt`).
* To upgrade vis-timeline, replace the vendored file with `standalone/umd/vis-timeline-graph2d.min.js`
  from the npm package.

## Tests

```
# unit/functional tests (Redmine's framework; run inside a Redmine checkout with a test database)
RAILS_ENV=test bundle exec rake redmine:plugins:test NAME=redmine_vis_gantt
# if the plugin directory is a symlink, point the helper at the Redmine root:
REDMINE_ROOT=/path/to/redmine RAILS_ENV=test bundle exec rake redmine:plugins:test NAME=redmine_vis_gantt
```

47 tests: data shape and ordering, hierarchy, editable flags, workflow read-only fields, relations,
query filters, private issues, row limit, permissions, closed projects, stale `lock_version`,
malformed input, rescheduling of followers and derived parents, and the "assets not compiled" warning.

Browser scenarios (real Chromium via Playwright, real mouse drags) are in `dev/e2e`:

```
RAILS_ENV=development bundle exec rails runner plugins/redmine_vis_gantt/dev/seed_demo.rb  # demo data
bundle exec rails server &
cd plugins/redmine_vis_gantt/dev/e2e && npm install
BASE=http://127.0.0.1:3000 node drag.js   # moving, resizing, followers, invalid moves, CSRF, history
BASE=http://127.0.0.1:3000 node ui.js     # permissions, collapse, zoom, filters, double-click, Russian
BASE=http://127.0.0.1:3000 node failures.js   # what the page shows when the script or the library cannot load
```

(`seed_demo.rb` resets the admin password and creates demo users: development databases only.)
Set `CHROME_PATH` to use an already installed Chromium.

## Performance

Measured in a development-mode Redmine on 470 issues (the default row limit is 500): the page is
rendered server-side in about 1.1 s versus about 2.3 s for the built-in Gantt on the same data;
panning in the browser costs about 15 ms per frame. vis-timeline only keeps the bars of the visible
time range in the DOM.

## Known limitations

* **Relation arrows** are drawn between bars that are currently in the DOM; an arrow to a bar outside
  the visible time range is not drawn.
* Not implemented compared to the built-in Gantt: PDF/PNG export, "display selected columns", the
  progress line, month/zoom parameters in the URL and in saved queries (the initial window is the
  current month plus six months; use zoom or "Show everything").
* Non-working days are not shaded according to Redmine's setting.
* Day granularity only (no time of day). Project and version bars are not draggable.
* An issue with no dates at all has no bar, so its dates cannot be set from the chart; issues with
  only one date are drawn as a one-day bar.
* Dragging starts after about 10 px of mouse movement (vis-timeline/Hammer.js dead zone).
* The row selection relies on the public methods of `Redmine::Helpers::Gantt` (`projects`, `issues`,
  `project_versions`, `relations`, ...). It works on 6.1 and 7.0 but should be re-checked on upgrades.

## Towards a resource Gantt

The structure carries over directly: rows = resources, bars = bookings, drag = change the booking.
What would change is the data (a `Resource` and a `Booking` model, conflict detection under a lock on
the resource row, per-resource calendars) and the update endpoint; the timeline, the drag handling
(snapping, validation in `onMoving`, optimistic update with rollback on `422`) and the Redmine
integration (menu, permissions, CSRF-protected session endpoints, tests) are already here.
