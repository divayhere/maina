import XCTest

final class MainaUITests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "com.divay.maina.staging")

  private var attachesToRunningApp: Bool {
    ProcessInfo.processInfo.environment["MAINA_UI_ATTACH_RUNNING"] == "1"
  }

  override func setUpWithError() throws {
    continueAfterFailure = false
    if attachesToRunningApp {
      app.activate()
      XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
      return
    }
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
    // A prior qualification case may legitimately leave Maina on a meeting
    // detail screen. Normalize every standalone case back to Home before
    // asserting the fresh-recording entry point.
    tapTab(named: "Home", fallbackX: 0.18)
    XCTAssertTrue(app.buttons["Record a meeting"].waitForExistence(timeout: 15))
  }

  /// Qualification-only control used by the USB soak harness. It deliberately
  /// attaches to an already-running recording instead of calling `launch()`,
  /// which would terminate the process and turn a graceful-stop test into an
  /// interruption-recovery test.
  func testStopExistingRecording() throws {
    XCTAssertTrue(attachesToRunningApp, "Set MAINA_UI_ATTACH_RUNNING=1 for this test.")
    let stop = app.buttons["Stop and save"]
    XCTAssertTrue(stop.waitForExistence(timeout: 15), "Maina is not showing an active recording.")
    attach("existing-recording-before-stop")
    stop.tap()
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(
        format: "label CONTAINS[c] 'transcrib' OR label CONTAINS[c] 'queued' OR label CONTAINS[c] 'saved'"
      )).firstMatch.waitForExistence(timeout: 30),
      "Maina did not acknowledge the recording stop."
    )
    attach("existing-recording-after-stop")
  }

  /// Qualification-only recovery control. This attaches to the exact running
  /// staging app and resolves a previously persisted interruption without
  /// launching a new recording or clearing application data.
  func testKeepInterruptedRecording() throws {
    XCTAssertTrue(attachesToRunningApp, "Set MAINA_UI_ATTACH_RUNNING=1 for this test.")
    let keep = app.buttons["Keep this recording"]
    XCTAssertTrue(keep.waitForExistence(timeout: 15), "Maina is not showing the interrupted-recording recovery choice.")
    attach("interrupted-recording-before-keep")
    keep.tap()
    XCTAssertFalse(keep.waitForExistence(timeout: 10), "The recovery choice did not close after keeping the recording.")
    XCTAssertTrue(assertCurrentMeetingHasDurableAudio(timeout: 20), "The kept recording has no public durable-audio evidence.")
    attach("interrupted-recording-after-keep")
  }

  func testNavigationAudit() throws {
    tapTab(named: "Home", fallbackX: 0.18)
    XCTAssertTrue(app.staticTexts["RECENT"].waitForExistence(timeout: 8))
    attach("home")

    tapTab(named: "To-dos", fallbackX: 0.82)
    XCTAssertTrue(app.staticTexts["To-dos"].waitForExistence(timeout: 8))
    attach("todos")

    openSettings()
    attach("settings")
  }

  func testShortRecordingLifecycle() throws {
    tapTab(named: "Home", fallbackX: 0.18)
    let record = app.buttons["Record a meeting"]
    XCTAssertTrue(record.waitForExistence(timeout: 5))
    record.tap()
    authorizeMicrophoneIfPresented()
    XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 10))
    sleep(8)
    attach("recording-listening")
    let advancedTimer = app.staticTexts.matching(NSPredicate(
      format: "label != '0:00' AND label MATCHES %@",
      "([0-9]+:)?[0-9]+:[0-9]{2}"
    )).firstMatch
    XCTAssertTrue(advancedTimer.waitForExistence(timeout: 3), "Recording timer did not advance")

    XCTAssertTrue(app.buttons["Pause"].waitForExistence(timeout: 5))
    app.buttons["Pause"].tap()
    XCTAssertTrue(app.staticTexts["Paused"].waitForExistence(timeout: 5))
    attach("recording-paused")

    XCTAssertTrue(app.buttons["Resume"].waitForExistence(timeout: 5))
    app.buttons["Resume"].tap()
    XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 5))
    sleep(8)

    XCTAssertTrue(app.buttons["Stop and save"].waitForExistence(timeout: 5))
    app.buttons["Stop and save"].tap()
    XCTAssertTrue(
      waitForRecorderFinalizationSurface(timeout: 20),
      "Maina did not leave the recorder after saving."
    )
    attach("recording-saved")
    assertSingleBackReturnsHomeIfNeeded()
  }

  func testRapidPauseResumeFirstTap() throws {
    startFreshRecording()
    app.buttons["Pause"].tap()
    let resume = app.buttons["Resume"]
    XCTAssertTrue(resume.waitForExistence(timeout: 5), "Resume did not become available after the first Pause tap.")
    resume.tap()
    XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 8), "The first Resume tap was not accepted.")
    attach("rapid-first-tap-resumed")
    stopCurrentRecording()
  }

  func testPausedStatePersistsUntilResume() throws {
    startFreshRecording()
    app.buttons["Pause"].tap()
    XCTAssertTrue(app.staticTexts["Paused"].waitForExistence(timeout: 5))
    sleep(5)
    XCTAssertTrue(app.staticTexts["Paused"].exists, "Recording left Paused without an explicit Resume.")
    XCTAssertTrue(app.buttons["Resume"].exists)
    attach("paused-state-held")
    app.buttons["Resume"].tap()
    XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 8))
    stopCurrentRecording()
  }

  func testBackgroundForegroundRecording() throws {
    startFreshRecording()
    sleep(5)
    attach("background-recording-before-home")
    XCUIDevice.shared.press(.home)
    sleep(12)
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
    XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 8), "Recording did not survive foreground restoration.")
    XCTAssertTrue(app.buttons["Stop and save"].exists)
    attach("background-recording-restored")
    stopCurrentRecording()
  }

  func testDiscardRecordingLifecycle() throws {
    startFreshRecording()
    sleep(4)
    let discard = app.descendants(matching: .any).matching(
      NSPredicate(format: "label == %@", "Discard this recording")
    ).firstMatch
    XCTAssertTrue(discard.waitForExistence(timeout: 5))
    discard.tap()
    let destructive = app.alerts.buttons["Discard this recording"]
    XCTAssertTrue(destructive.waitForExistence(timeout: 5))
    destructive.tap()
    XCTAssertTrue(app.buttons["Record a meeting"].waitForExistence(timeout: 20))
    attach("recording-discarded")
  }

  func testProcessDeathRecovery() throws {
    tapTab(named: "Home", fallbackX: 0.18)
    let previousMeetingCount = requireHomeRecordingCount(timeout: 8)
    startFreshRecording()
    sleep(8)
    attach("process-recovery-before-termination")
    app.terminate()
    sleep(3)
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
    let keep = app.buttons["Keep this recording"]
    if keep.waitForExistence(timeout: 12) {
      keep.tap()
      XCTAssertFalse(keep.waitForExistence(timeout: 15))
    }
    tapTab(named: "Home", fallbackX: 0.18)
    XCTAssertTrue(
      waitForHomeRecordingCount(previousMeetingCount + 1, timeout: 25),
      "Process-death recovery did not create exactly one new public meeting."
    )
    let newestMeeting = app.buttons.matching(identifier: "meeting-card").firstMatch
    XCTAssertTrue(newestMeeting.waitForExistence(timeout: 8), "The recovered top meeting card is unavailable.")
    newestMeeting.tap()
    XCTAssertTrue(assertCurrentMeetingHasDurableAudio(timeout: 20), "The recovered meeting has no public durable-audio evidence.")
    let recoveredDuration = requireCurrentMeetingDurationSeconds()
    XCTAssertTrue((1...60).contains(recoveredDuration), "Recovered meeting duration is inconsistent with the bounded interrupted recording.")
    XCTAssertFalse(app.buttons["Stop and save"].exists, "Recovered meeting still exposes recording controls.")
    XCTAssertFalse(app.staticTexts["Recording"].exists, "Recovered meeting still claims an active recording.")
    attach("process-recovery-complete")
  }

  func testLongRecordingWithBackgroundAndPauses() throws {
    startFreshRecording()
    sleep(30)
    attach("long-recording-foreground")
    XCUIDevice.shared.press(.home)
    sleep(15)
    app.activate()
    XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 10))
    app.buttons["Pause"].tap()
    XCTAssertTrue(app.staticTexts["Paused"].waitForExistence(timeout: 5))
    sleep(10)
    app.buttons["Resume"].tap()
    XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 8))
    sleep(35)
    attach("long-recording-after-resume")
    stopCurrentRecording()
  }

  func testCloudPairingWithExternalApproval() throws {
    openSettings()

    // A signed simulator preserves its Keychain session between qualification
    // runs. An already-connected phone is a valid end state and should not be
    // forced through a second pairing request.
    if app.staticTexts["Maina Cloud connected"].exists {
      XCTAssertTrue(app.staticTexts["Connected"].exists)
      attach("cloud-already-connected")
      return
    }

    let connect = app.buttons["Connect this phone"]
    for _ in 0..<4 where !connect.exists {
      app.swipeUp()
    }
    XCTAssertTrue(connect.waitForExistence(timeout: 8))
    connect.tap()
    XCTAssertTrue(app.staticTexts["PAIRING CODE"].waitForExistence(timeout: 15))
    attach("cloud-pairing-code")

    // The qualification harness approves the newest pending request against
    // the same remote D1 while this test waits. No credential enters the app.
    sleep(30)
    let approved = app.buttons["I approved this phone"]
    XCTAssertTrue(approved.waitForExistence(timeout: 5))
    approved.tap()
    XCTAssertTrue(app.staticTexts["Maina Cloud connected"].waitForExistence(timeout: 20))
    attach("cloud-connected")
  }

  private func openSettings() {
    tapTab(named: "Home", fallbackX: 0.18)
    sleep(1)
    app.coordinate(withNormalizedOffset: .init(dx: 0.08, dy: 0.10)).tap()
    sleep(1)
    app.coordinate(withNormalizedOffset: .init(dx: 0.22, dy: 0.23)).tap()
    XCTAssertTrue(app.staticTexts["MAINA CLOUD"].waitForExistence(timeout: 8))
  }

  private func startFreshRecording() {
    tapTab(named: "Home", fallbackX: 0.18)
    let record = app.buttons["Record a meeting"]
    XCTAssertTrue(record.waitForExistence(timeout: 8))
    record.tap()
    authorizeMicrophoneIfPresented()
    XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 12))
  }

  private func stopCurrentRecording() {
    let stop = app.buttons["Stop and save"]
    XCTAssertTrue(stop.waitForExistence(timeout: 8))
    stop.tap()
    XCTAssertTrue(
      waitForRecorderFinalizationSurface(timeout: 30),
      "Maina did not leave the recorder after saving."
    )
  }

  private func authorizeMicrophoneIfPresented() {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let alert = springboard.alerts.firstMatch
    guard alert.waitForExistence(timeout: 2) else { return }
    guard alert.staticTexts["“Maina” would like to access the Microphone."].exists else {
      XCTFail("Unexpected system permission alert while starting a recording.")
      return
    }
    let allow = alert.buttons["Allow"]
    guard allow.exists else {
      XCTFail("Expected microphone permission action is unavailable.")
      return
    }
    allow.tap()
    XCTAssertFalse(alert.waitForExistence(timeout: 5), "Microphone permission alert did not close.")
  }

  private func waitForRecorderFinalizationSurface(timeout: TimeInterval) -> Bool {
    let home = app.staticTexts["RECENT"]
    let record = app.buttons["Record a meeting"]
    let detailBack = app.buttons["Back"].firstMatch
    let detailNotes = app.staticTexts["Notes"]
    let detailTranscript = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Transcript")).firstMatch
    let detailTodos = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "To-dos")).firstMatch
    let stop = app.buttons["Stop and save"]
    let pause = app.buttons["Pause"]
    let resume = app.buttons["Resume"]
    let recording = app.staticTexts["Recording"]
    let paused = app.staticTexts["Paused"]
    let deadline = Date().addingTimeInterval(timeout)
    var consecutiveSettledSamples = 0
    repeat {
      let recordingSurfaceIsGone = !stop.exists && !pause.exists && !resume.exists && !recording.exists && !paused.exists
      let homeIsSettled = home.exists && record.exists && record.isHittable
      let detailIsSettled = detailBack.exists && detailBack.isHittable
        && detailNotes.exists && detailTranscript.exists && detailTranscript.isHittable && detailTodos.exists
      if recordingSurfaceIsGone && (homeIsSettled || detailIsSettled) {
        consecutiveSettledSamples += 1
        if consecutiveSettledSamples == 2 { return true }
      } else {
        consecutiveSettledSamples = 0
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    } while Date() < deadline
    return false
  }

  private func requireHomeRecordingCount(timeout: TimeInterval) -> Int {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if let count = currentHomeRecordingCount() { return count }
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    } while Date() < deadline
    XCTFail("Home did not expose exactly one bounded recording count.")
    return -1
  }

  private func waitForHomeRecordingCount(_ expected: Int, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if currentHomeRecordingCount() == expected { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    } while Date() < deadline
    return false
  }

  private func currentHomeRecordingCount() -> Int? {
    let matches = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^[0-9]+ recordings?$"))
    guard matches.count == 1,
          let prefix = matches.firstMatch.label.split(separator: " ").first,
          let count = Int(prefix) else { return nil }
    return count
  }

  private func assertCurrentMeetingHasDurableAudio(timeout: TimeInterval) -> Bool {
    let audioAvailable = app.staticTexts["Audio available: Yes"]
    let positiveSegments = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^Saved audio segments: [1-9][0-9]*$"))
    let reTranscribe = app.buttons["Re-transcribe from saved audio"]
    let audioKept = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "audio kept"))
    let deadline = Date().addingTimeInterval(timeout)
    var openedTranscript = false
    repeat {
      if audioAvailable.exists || positiveSegments.count == 1 || reTranscribe.exists || audioKept.count > 0 { return true }
      let transcript = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Transcript")).firstMatch
      if !openedTranscript && transcript.exists && transcript.isHittable {
        transcript.tap()
        openedTranscript = true
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    } while Date() < deadline
    return false
  }

  private func requireCurrentMeetingDurationSeconds() -> Int {
    for element in app.staticTexts.allElementsBoundByIndex {
      let fields = element.label.components(separatedBy: " · ")
      guard fields.count >= 3 else { continue }
      for candidate in fields.reversed() {
        let rawParts = candidate.split(separator: ":")
        let parts = rawParts.compactMap { Int($0) }
        guard rawParts.count == parts.count, parts.count == 2 || parts.count == 3 else { continue }
        if parts.count == 2, parts[1] < 60 { return parts[0] * 60 + parts[1] }
        if parts.count == 3, parts[1] < 60, parts[2] < 60 { return parts[0] * 3600 + parts[1] * 60 + parts[2] }
      }
    }
    XCTFail("Meeting detail did not expose a bounded public duration.")
    return -1
  }

  private func assertSingleBackReturnsHomeIfNeeded() {
    if app.staticTexts["RECENT"].exists {
      XCTAssertTrue(app.buttons["Record a meeting"].isHittable)
      return
    }
    let back = app.buttons["Back"].firstMatch
    XCTAssertTrue(back.exists && back.isHittable, "Settled post-recording detail did not expose one usable Back action.")
    back.tap()
    XCTAssertTrue(app.staticTexts["RECENT"].waitForExistence(timeout: 10), "One Back did not return to Home.")
    XCTAssertTrue(app.buttons["Record a meeting"].waitForExistence(timeout: 5), "Home recording entry point is unavailable after Back.")
    attach("recording-saved-back-home")
  }

  private func tapTab(named name: String, fallbackX: CGFloat) {
    let tab = app.buttons[name]
    if tab.waitForExistence(timeout: 5) {
      tab.tap()
    } else {
      app.coordinate(withNormalizedOffset: .init(dx: fallbackX, dy: 0.90)).tap()
    }
  }

  private func attach(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
