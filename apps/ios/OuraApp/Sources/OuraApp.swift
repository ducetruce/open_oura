import SwiftUI

@main
struct OuraApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            TabView {
                TodayView()
                    .tabItem { Label("Today", systemImage: "sun.max") }
                SleepView()
                    .tabItem { Label("Sleep", systemImage: "bed.double") }
                TrendsView()
                    .tabItem { Label("Trends", systemImage: "chart.xyaxis.line") }
                RingView()
                    .tabItem { Label("Ring", systemImage: "circle.circle") }
            }
            .environmentObject(model)
            .task { await model.reloadStoredData() }
            .alert(
                "Something went wrong",
                isPresented: Binding(
                    get: { model.errorMessage != nil },
                    set: { if !$0 { model.errorMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.errorMessage ?? "")
            }
        }
    }
}

/// Day stepper + sync button shared by the Today and Sleep tabs.
struct DayToolbar: ToolbarContent {
    let model: AppModel

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarLeading) {
            Button {
                model.stepDay(-1)
            } label: {
                Label("Previous day", systemImage: "chevron.left")
            }
            .disabled(!model.canStepDay(-1))
            Button {
                model.stepDay(1)
            } label: {
                Label("Next day", systemImage: "chevron.right")
            }
            .disabled(!model.canStepDay(1))
        }
        ToolbarItem(placement: .topBarTrailing) {
            if model.isBusy {
                ProgressView()
            } else {
                Button {
                    Task { await model.sync() }
                } label: {
                    Label("Sync", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(!model.isConnected || !model.hasKey)
            }
        }
    }
}

/// Shown on data tabs before anything has been synced.
struct NoDataView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ContentUnavailableView {
            Label("No ring data yet", systemImage: "circle.dashed")
        } description: {
            if !model.hasKey || model.ring.rememberedRing == nil {
                Text("Connect your ring and add its key in the Ring tab, then sync.")
            } else if model.isConnected {
                Text("Your ring is connected. Sync to pull its history.")
            } else {
                Text("Bring your ring close to connect, then sync.")
            }
        } actions: {
            if model.isConnected && model.hasKey {
                Button("Sync now") { Task { await model.sync() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isBusy)
            }
        }
    }
}
