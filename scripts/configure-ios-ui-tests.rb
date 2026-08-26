#!/usr/bin/env ruby
# frozen_string_literal: true

require "xcodeproj"
require "fileutils"

project_path = File.expand_path("../ios/Maina.xcodeproj", __dir__)
template_path = File.expand_path("../ios-tests/MainaUITests.swift", __dir__)
source_path = File.expand_path("../ios/MainaUITests/MainaUITests.swift", __dir__)
abort "Missing UI test template: #{template_path}" unless File.file?(template_path)
FileUtils.mkdir_p(File.dirname(source_path))
FileUtils.cp(template_path, source_path)

project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == "Maina" }
abort "Maina app target was not found" unless app

# Expo prebuild intentionally regenerates the native project and does not keep
# Xcode's local signing selection. Reapply the known staging team to the app as
# part of the deterministic local preparation step so device builds do not
# depend on a hand-edited Xcode project.
team_id = ENV.fetch("MAINA_IOS_TEAM_ID", "9X4X3R4KCN")
app.build_configurations.each do |configuration|
  configuration.build_settings["DEVELOPMENT_TEAM"] = team_id
  configuration.build_settings["CODE_SIGN_STYLE"] = "Automatic"
end

target = project.targets.find { |candidate| candidate.name == "MainaUITests" }
target ||= project.new_target(:ui_test_bundle, "MainaUITests", :ios, "16.4")

group = project.main_group.find_subpath("MainaUITests", true)
matching_references = group.files.select { |file| File.basename(file.path.to_s) == "MainaUITests.swift" }
reference = matching_references.first
reference ||= group.new_file(source_path)
matching_references.drop(1).each(&:remove_from_project)
unless target.source_build_phase.files_references.include?(reference)
  target.add_file_references([reference])
end

target.add_dependency(app) unless target.dependencies.any? { |dependency| dependency.target == app }
target.build_configurations.each do |configuration|
  configuration.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "com.divay.maina.staging.uitests"
  configuration.build_settings["PRODUCT_NAME"] = "MainaUITests"
  configuration.build_settings["TEST_TARGET_NAME"] = "Maina"
  configuration.build_settings["DEVELOPMENT_TEAM"] = team_id
  configuration.build_settings["CODE_SIGN_STYLE"] = "Automatic"
  configuration.build_settings["SWIFT_VERSION"] = "5.0"
  configuration.build_settings["GENERATE_INFOPLIST_FILE"] = "YES"
  configuration.build_settings["IPHONEOS_DEPLOYMENT_TARGET"] = "16.4"
end

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_test_target(target)
scheme.set_launch_target(app)
scheme.test_action.build_configuration = "Release"
scheme.launch_action.build_configuration = "Release"
scheme.save_as(project_path, "MainaUITests", true)

project.save
puts "MainaUITests target and shared scheme are configured."
