import XCTest

final class MainaUITests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "com.divay.maina.staging")

  override func setUpWithError() throws {
    continueAfterFailure = false
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
  }

  func testNavigationAudit() throws {
    tapTab(named: "Home", fallbackX: 0.18)
    attach("home")

    tapTab(named: "To-dos", fallbackX: 0.82)
    attach("todos")

    openSettings()
    attach("settings")
  }

  func testShortRecordingLifecycle() throws {
    tapTab(named: "Home", fallbackX: 0.18)
    let record = app.buttons["Record a meeting"]
    XCTAssertTrue(record.waitForExistence(timeout: 5))
    record.tap()
    XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 10))
    sleep(8)
    attach("recording-listening")

    XCTAssertTrue(app.buttons["Pause"].waitForExistence(timeout: 5))
    app.buttons["Pause"].tap()
    XCTAssertTrue(app.staticTexts["Paused"].waitForExistence(timeout: 5))
    attach("recording-paused")

    XCTAssertTrue(app.buttons["Resume"].waitForExistence(timeout: 5))
    app.buttons["Resume"].tap()
    XCTAssertTrue(app.staticTexts["Listening"].waitForExistence(timeout: 5))
    sleep(8)

    XCTAssertTrue(app.buttons["Stop and save"].waitForExistence(timeout: 5))
    app.buttons["Stop and save"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'Recent' OR label CONTAINS[c] 'recording'")).firstMatch.waitForExistence(timeout: 20))
    attach("recording-saved")
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

  private func tapTab(named name: String, fallbackX: CGFloat) {
    let tab = app.buttons[name]
    if tab.exists { tab.tap() } else { app.coordinate(withNormalizedOffset: .init(dx: fallbackX, dy: 0.90)).tap() }
  }

  private func attach(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
