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
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(
        format: "label CONTAINS[c] 'Notes' OR label CONTAINS[c] 'Transcript' OR label CONTAINS[c] 'Recent'"
      )).firstMatch.waitForExistence(timeout: 20),
      "Maina did not return to a durable meeting or home state."
    )
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
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'Recent' OR label CONTAINS[c] 'recording'")).firstMatch.waitForExistence(timeout: 20))
    attach("recording-saved")
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
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(
        format: "label CONTAINS[c] 'Notes' OR label CONTAINS[c] 'Transcript' OR label CONTAINS[c] 'Recent'"
      )).firstMatch.waitForExistence(timeout: 25),
      "Maina did not recover to a durable meeting or home surface after process death."
    )
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
    XCTAssertTrue(app.staticTexts["Recording"].waitForExistence(timeout: 12))
  }

  private func stopCurrentRecording() {
    let stop = app.buttons["Stop and save"]
    XCTAssertTrue(stop.waitForExistence(timeout: 8))
    stop.tap()
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(
        format: "label CONTAINS[c] 'Recent' OR label CONTAINS[c] 'recording' OR label CONTAINS[c] 'transcrib'"
      )).firstMatch.waitForExistence(timeout: 30),
      "Maina did not publish a durable post-recording state."
    )
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
