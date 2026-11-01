# Kovi phone apps (iPhone + Android)

These wrap the live Kovi web app in a native shell (Capacitor) so it can be listed on the App Store and Google Play.
The app loads https://kovi-...run.app (change `server.url` to your own domain once you have one) and adds " KoviApp" to the
user agent. In that mode Kovi hides company sign-up and card billing, so the stores' payment rules don't apply to the app:
companies sign up and pay on the website; drivers and managers just sign in.

## You need (I can't do these for you)
- Apple Developer Program, £79/yr, and a Mac with Xcode (iOS builds can only be made on a Mac)
- Google Play Console, one-off $25, and Android Studio (any computer)

## Build
    cd mobile && npm install
    npx cap add ios && npx cap add android
    # iOS: add to ios/App/App/Info.plist
    #   NSCameraUsageDescription: Kovi takes photos of defects and handovers.
    #   NSLocationWhenInUseUsageDescription: Kovi records where a walkaround check was done.
    # Android: AndroidManifest.xml needs CAMERA, ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION
    # Put store/app-icon-1024.png in as the app icon (Xcode: Assets; Android Studio: Image Asset)
    npx cap sync && npx cap open ios   (or android)
Then archive in Xcode / build a signed bundle in Android Studio and upload. Listing text, privacy answers and
screenshots are in ../store/.

## Honest risk
Apple (guideline 4.2) can reject apps that are only a website. Kovi uses camera and GPS, works offline and has
sign-in, which usually passes, but a first rejection is possible. Reply in App Review, mention the native camera/GPS use.
