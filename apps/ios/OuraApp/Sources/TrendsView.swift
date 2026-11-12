import Charts
import SwiftUI

struct TrendsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                if let days = model.summary?.days, !days.isEmpty {
                    ScrollView {
                        VStack(spacing: 16) {
                            trend("Readiness score", unit: "Score", tint: .green, days: days, value: \.readinessScoreValue)
                            trend("Sleep score", unit: "Score", tint: .indigo, days: days, value: \.sleepScoreValue)
                            trend("Oura-style sleep score", unit: "Score", tint: .teal, days: days, value: \.ouraSleepScoreValue)
                            Card(title: "Sleep") {
                                Chart {
                                    ForEach(sleepHours(days), id: \.0) { day, hours in
                                        BarMark(
                                            x: .value("Day", day, unit: .day),
                                            y: .value("Hours", hours)
                                        )
                                        .foregroundStyle(.indigo)
                                    }
                                }
                                .frame(height: 160)
                            }
                            trend("Resting heart rate", unit: "bpm", tint: .red, days: days, value: \.restingHrBpm)
                            trend("HRV", unit: "ms", tint: .purple, days: days, value: \.avgHrvMs)
                            trend("Skin temperature", unit: "°C", tint: .orange, days: days, value: \.skinTempC)
                            trend("Blood oxygen", unit: "%", tint: .cyan, days: days, value: \.avgSpo2Percent)
                            trend("Average activity", unit: "MET", tint: .green, days: days, value: \.avgMet)
                        }
                        .padding()
                    }
                    .background(Color(.systemGroupedBackground))
                } else {
                    NoDataView()
                }
            }
            .navigationTitle("Trends")
        }
    }

    private func sleepHours(_ days: [DaySummary]) -> [(Date, Double)] {
        days.compactMap { day in
            guard let night = day.sleep else { return nil }
            let seconds = night.stagesComplete ? night.totalSleepS : night.timeInBedS
            return (day.midday, Double(seconds) / 3600)
        }
    }

    @ViewBuilder
    private func trend(
        _ title: String,
        unit: String,
        tint: Color,
        days: [DaySummary],
        value: KeyPath<DaySummary, Double?>
    ) -> some View {
        let points: [(Date, Double)] = days.compactMap { day in
            guard let amount = day[keyPath: value] else { return nil }
            return (day.midday, amount)
        }
        if !points.isEmpty {
            Card(title: title) {
                Chart {
                    ForEach(points, id: \.0) { day, amount in
                        LineMark(x: .value("Day", day, unit: .day), y: .value(unit, amount))
                            .foregroundStyle(tint)
                        PointMark(x: .value("Day", day, unit: .day), y: .value(unit, amount))
                            .foregroundStyle(tint)
                    }
                }
                .chartYScale(domain: .automatic(includesZero: false))
                .frame(height: 140)
            }
        }
    }
}
