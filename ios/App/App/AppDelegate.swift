import UIKit
import Capacitor

/**
 * The iPad/iPhone app is a thin native shell (Capacitor) around the shared web app,
 * like the Android one. Native entry points added here:
 *  - assistant://open#/route links (Shortcuts app, "Draft from shared text") → routes in the app.
 *  - Home Screen quick actions (long-press the icon): "Drafts waiting", "Chat with Claude".
 *  - Push: hands the APNs device token to the Capacitor push plugin.
 */
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        if let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem {
            // Cold start from a quick action: open its link once the web app has loaded.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { _ = self.openShortcut(item) }
            return false // tells iOS not to call performActionFor as well
        }
        return true
    }

    func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(openShortcut(shortcutItem))
    }

    private func openShortcut(_ item: UIApplicationShortcutItem) -> Bool {
        guard let s = item.userInfo?["url"] as? String, let url = URL(string: s) else { return false }
        return ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Keeps the App plugin's "appUrlOpen" event working (the web app routes on it).
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // MARK: Push notifications (needs a paid Apple Developer account; see docs/IOS.md)

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
}
