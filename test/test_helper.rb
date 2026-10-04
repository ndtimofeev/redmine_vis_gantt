# frozen_string_literal: true

# Plugin tests run inside Redmine's own test setup:
#
#   RAILS_ENV=test bundle exec rake redmine:plugins:test NAME=redmine_vis_gantt
#
# When the plugin directory is a symlink into plugins/, __dir__ is the real
# path and the Redmine root cannot be derived from it: set REDMINE_ROOT.
redmine_root = ENV['REDMINE_ROOT'] || File.expand_path('../../..', __dir__)
require File.join(redmine_root, 'test', 'test_helper')
