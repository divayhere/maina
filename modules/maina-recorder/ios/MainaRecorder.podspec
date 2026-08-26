Pod::Spec.new do |s|
  s.name           = 'MainaRecorder'
  s.version        = '0.1.0'
  s.summary        = 'Maina iOS recorder bridge'
  s.description    = 'Native iOS recording, route, and durable processing bridge for Maina.'
  s.author         = 'Maina'
  s.homepage       = 'https://github.com/divayhere/maina'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
