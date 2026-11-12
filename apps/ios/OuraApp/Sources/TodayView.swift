import SwiftUI

struct TodayView: View {
    @EnvironmentObject private var model: AppModel

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        NavigationStack {
            Group {
                if let day = model.selectedDay {
                    ScrollView {
                        VStack(spacing: 16) {
                            if let progress = model.syncProgress {
                                Label(progress, systemImage: "arrow.triangle.2.circlepath")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            metrics(for: day)
                            if !day.heartRate.isEmpty {
                                Card(title: "Heart rate") {
                                    SeriesChart(points: day.heartRate, unit: "bpm", tint: .red)
                                }
                            }
                            if !day.hrv.isEmpty {
                                Card(title: "Heart rate variability") {
                                    SeriesChart(points: day.hrv, unit: "ms", tint: .purple)
                                }
                            }
                            if !day.met.isEmpty {
                                Card(title: "Activity (MET)") {
                                    SeriesChart(points: day.met, unit: "MET", tint: .green)
                                }
                            }
                            if model.summary?.clockEstimated == true {
                                Text("Some times are estimated: the ring had no clock reference for part of this data. Turn on “Set ring clock when syncing” in the Ring tab to fix future data.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding()
                    }
                    .background(Color(.systemGroupedBackground))
                    .navigationTitle(day.title)
                } else {
                    NoDataView().navigationTitle("Today")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { DayToolbar(model: model) }
            .refreshable { await model.sync() }
        }
    }

    private func metrics(for day: DaySummary) -> some View {
        LazyVGrid(columns: columns, spacing: 12) {
            MetricCard(
                title: "Sleep",
                value: sleepValue(day.sleep),
                systemImage: "bed.double.fill",
                tint: .indigo
            )
            MetricCard(
                title: "Resting heart rate",
                value: formatValue(day.restingHrBpm),
                unit: "bpm",
                systemImage: "heart.fill",
                tint: .red
            )
            MetricCard(
                title: "HRV",
                value: formatValue(day.avgHrvMs),
                unit: "ms",
                systemImage: "waveform.path.ecg",
                tint: .purple
            )
            MetricCard(
                title: "Blood oxygen",
                value: formatValue(day.avgSpo2Percent),
                unit: "%",
                systemImage: "lungs.fill",
                tint: .cyan
            )
            MetricCard(
                title: "Skin temperature",
                value: formatValue(day.skinTempC, digits: 1),
                unit: "°C",
                systemImage: "thermometer.medium",
                tint: .orange
            )
            MetricCard(
                title: "Average activity",
                value: formatValue(day.avgMet, digits: 1),
                unit: "MET",
                systemImage: "figure.walk",
                tint: .green
            )
        }
    }

    private func sleepValue(_ night: SleepNight?) -> String {
        guard let night else { return "–" }
        return formatDuration(seconds: night.hasStages ? night.totalSleepS : night.timeInBedS)
    }
}
