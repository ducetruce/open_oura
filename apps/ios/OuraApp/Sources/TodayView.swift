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
                            scores(for: day)
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
                                Text("Some times are estimated: part of this data was recorded before the ring had a clock reference. Data synced from now on is timed exactly.")
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

    private func scores(for day: DaySummary) -> some View {
        let readiness = day.sleep?.readinessScore
        return Card(title: "Scores") {
            HStack(alignment: .top) {
                ScoreRing(title: "Readiness", score: readiness, tint: .green)
                ScoreRing(title: "Sleep", score: day.sleep?.sleepScore, tint: .indigo)
                if let calibrated = day.sleep?.ouraSleepScore {
                    ScoreRing(title: "Sleep", score: calibrated, tint: .teal)
                }
            }
            if let readiness {
                ContributorList(score: readiness, tint: .green)
                Text(readiness.basis.explanation)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if readiness.provisional {
                    Text("Provisional until about two weeks of nights have been synced: readiness compares each night with your own baseline.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Readiness appears after a few nights have been synced: it compares each night with your own baseline.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
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
        return formatDuration(seconds: night.stagesComplete ? night.totalSleepS : night.timeInBedS)
    }
}
