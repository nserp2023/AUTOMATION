# Vajra Smart Hub browser companion

This static browser app is a cross-device companion to the Android project. Its dashboard follows the Android app's room and master-group layout, and supports its 136 configurable switch points across the ESP32 board and eight PCF8575 expanders. Like the Android app, points map to the eight relay channels over MQTT using the same topic format:

- Subscribe: `<topic-prefix>/relay1/status` through `<topic-prefix>/relay8/status`
- Publish: `<topic-prefix>/relay1/set` through `<topic-prefix>/relay8/set`, with `ON` or `OFF`

It uses a secure WebSocket (`wss://`) connection, so it can run on GitHub Pages and in modern Chrome, Safari, Firefox, and Edge. Relay states are updated from broker status messages; a sent command is not treated as proof that the physical relay changed. Room assignments, switch names and icons, enabled boards/switch points, groups, hub profiles, schedules, and timers are stored locally in each browser. These settings do not synchronize with the Android app.

## Publish with GitHub Pages

1. Push this project folder's contents to the root of a GitHub repository, with the `web` and `.github` folders at the repository root.
2. In the repository, open **Settings → Pages** and set the build source to **GitHub Actions**.
3. Push a change to the `main` branch, or manually run **Deploy browser app to GitHub Pages** from the **Actions** tab.
4. Open the published HTTPS Pages URL on each device and install/add it to the home screen:
   - **iPhone/iPad:** open the URL in Safari, tap **Share → Add to Home Screen**, then tap **Add**.
   - **Android:** open the URL in Chrome and choose **Install app** or **Add to Home screen** from the menu.
   - **Windows/macOS/Linux:** open the URL in a supported desktop browser and use its install-app control in the address bar or browser menu, when available.

The workflow deploys only `web/`; the Android project remains unchanged. GitHub Pages supplies HTTPS, which is needed for the secure WebSocket connection and installable web app features.

The app layout adapts to narrow phone screens, tablets, and desktop windows. The browser version shares the MQTT relay controls, but it is not a full replacement for Android-only features such as Bluetooth, OTA firmware flashing, local-network discovery, and native background schedules.

## Connect the hub

Open **Connection settings** and set:

- **Secure WebSocket URL**: a WSS endpoint enabled on your MQTT broker. The default is `wss://broker.emqx.io:8084/mqtt`.
- **MQTT topic prefix**: exactly the same prefix configured in the hub/Android app. Set a unique prefix on the hub and enter it here; the browser intentionally does not prefill the Android app's public default.
- **Username/password**: only if required by your broker. The password stays in session storage and is cleared when the browser session ends.

Settings are local to each browser/device and do not sync automatically. The username, URL, and prefix are stored in that browser's local storage. Do not save credentials on a shared device.

To open Board Settings, enter the app access code **290771**. To add another hub, open **Board Settings → Saved Hubs**, enter its name, local IP address, and the exact MQTT topic prefix configured on that hub, then select **Save Hub**. Saving stores a connection profile in this browser; it does not discover or configure hardware. Select the saved profile to make it the active hub. To add PCF8575 expansion-board switch points instead, use **Active Relays**, enable the board and its switch points, save, then assign those points to a room.

## Security and browser limitations

The default EMQX public broker does not make your messages private. The Android project's current default topic prefix is public in its source code, so other broker users may be able to observe or publish relay commands if you continue using it. Set a new unique prefix on the hub and in this browser and, preferably, use a private broker with authentication and access controls before controlling real equipment. Do not put broker passwords in source code or GitHub.

The browser edition reproduces the Android dashboard's rooms, groups, switch-point configuration, schedules, timers, and saved-hub controls, using the same eight relay-channel mapping. Browser schedules and countdowns can only run while the page remains active; iOS and desktop browsers cannot provide the Android app's exact alarms after it closes. Browser support also differs for local HTTP, subnet discovery, Bluetooth SPP, and OTA flashing. These native features remain available only in the Android app. Safari and GitHub Pages cannot use the Android app's raw TCP MQTT connection; the broker must expose MQTT over secure WebSocket.

MQTT uses a public broker by default unless you configure a private endpoint. A shared public topic prefix can allow other users to observe or send relay commands. Configure a unique prefix and authenticated private broker before controlling real equipment. Browser settings are stored per device; MQTT passwords are kept only in the current browser session.

## Local preview

Serve this folder from a local HTTP server (for example, `python -m http.server 8000` while the terminal is in `web/`) and open `http://localhost:8000`. Directly opening `index.html` as a `file://` URL will not enable the service worker.
