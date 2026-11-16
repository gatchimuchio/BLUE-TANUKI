import SwiftUI

@main
struct BlueTanukiApp: App {
  @StateObject private var model = DeviceLinkViewModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      ContentView(model: model)
        .onAppear { model.loadLocalState() }
        .onChange(of: scenePhase) { phase in
          model.setForeground(phase == .active)
        }
    }
  }
}
