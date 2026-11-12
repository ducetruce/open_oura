import Charts
import SwiftUI

struct SleepView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                if let day = model.selectedDay {
                    if let night = day.sleep {
                        ScrollView {
                            NightDetail(night: night).padding()
                        }
                        .background(Color(.systemGroupedBackground))
                        .navigationTitle(day.title)
                    } else {
                        ContentUnavailableView(
                            "No sleep recorded",
                            systemImage: "moon.zzz",
                            description: Text("The ring logged no night ending on this day.")
                        )
                        .navigationTitle(day.title)
                    }
                } else {
                    NoDataView().navigationTitle("Sleep")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { DayToolbar(model: model) }
        }
    }
}

private struct NightDetail: View {
    let night: SleepNight

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        VStack(spacing: 16) {
            Card(title: "Night") {
                HStack {
                    VStack(alignment: .leading) {
                        Text(night.stagesComplete ? "Asleep" : "In bed")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(formatDuration(seconds: night.stagesComplete ? night.totalSleepS : night.timeInBedS))
                            .font(.largeTitle.weight(.semibold))
                            .monospacedDigit()
                    }
                    Spacer()
                    VStack(alignment: .trailing) {
                        Text(dateFromUnix(night.startUnix), format: .dateTime.hour().minute())
                        Text(dateFromUnix(night.endUnix), format: .dateTime.hour().minute())
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                }
            }

            if let score = night.sleepScore {
                ScoreCard(title: "Sleep score", score: score, tint: .indigo)
            }
            if let score = night.ouraSleepScore {
                ScoreCard(title: "Oura-style sleep score", score: score, tint: .teal)
            }

            if night.hasStages {
                Card(title: "Stages") {
                    Hypnogram(night: night)
                    StageBreakdown(night: night)
                    Text(night.stagesComplete
                        ? "Stages are the ring’s own analysis, not Oura’s phone-side model, so they can differ from the official app."
                        : "The ring analysed only part of this night. The grey gaps are not awake time, and efficiency and scores are left out.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            LazyVGrid(columns: columns, spacing: 12) {
                if night.stagesComplete {
                    MetricCard(
                        title: "Efficiency",
                        value: formatValue(night.efficiency * 100),
                        unit: "%",
                        systemImage: "gauge.medium",
                        tint: .indigo
                    )
                    MetricCard(
                        title: "Time to fall asleep",
                        value: formatDuration(seconds: night.latencyS),
                        systemImage: "hourglass",
                        tint: .indigo
                    )
                    MetricCard(
                        title: "Awake during the night",
                        value: formatDuration(seconds: night.wasoS),
                        systemImage: "eye",
                        tint: .orange
                    )
                    MetricCard(
                        title: "Awakenings",
                        value: String(night.wakeCount),
                        systemImage: "bell",
                        tint: .orange
                    )
                }
                MetricCard(
                    title: "Time in bed",
                    value: formatDuration(seconds: night.timeInBedS),
                    systemImage: "bed.double.fill",
                    tint: .indigo
                )
                MetricCard(
                    title: "Lowest heart rate",
                    value: formatValue(night.lowestHrBpm),
                    unit: "bpm",
                    systemImage: "heart.fill",
                    tint: .red
                )
                MetricCard(
                    title: "Average heart rate",
                    value: formatValue(night.avgHrBpm),
                    unit: "bpm",
                    systemImage: "heart",
                    tint: .red
                )
                MetricCard(
                    title: "HRV",
                    value: formatValue(night.avgHrvMs),
                    unit: "ms",
                    systemImage: "waveform.path.ecg",
                    tint: .purple
                )
                MetricCard(
                    title: "Breathing rate",
                    value: formatValue(night.avgBreathRate, digits: 1),
                    unit: "/min",
                    systemImage: "wind",
                    tint: .mint
                )
                MetricCard(
                    title: "Blood oxygen",
                    value: formatValue(night.avgSpo2Percent),
                    unit: "%",
                    systemImage: "lungs.fill",
                    tint: .cyan
                )
                MetricCard(
                    title: "Skin temperature",
                    value: formatValue(night.skinTempC, digits: 1),
                    unit: "°C",
                    systemImage: "thermometer.medium",
                    tint: .orange
                )
            }
        }
    }
}

private struct ScoreCard: View {
    let title: String
    let score: Score
    let tint: Color

    var body: some View {
        Card(title: title) {
            HStack {
                ScoreRing(title: "Sleep", score: score, tint: tint)
            }
            ContributorList(score: score, tint: tint)
            Text(score.basis.explanation)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

/// The night's stages as coloured blocks on a time axis. Epochs the ring did not
/// analyse are left blank.
private struct Hypnogram: View {
    let night: SleepNight

    private struct Block: Identifiable {
        let id: Int
        let stage: SleepStage
        let start: Date
        let end: Date
    }

    /// Consecutive epochs of the same stage merged into one block.
    private var blocks: [Block] {
        let codes = [UInt8](night.stages)
        guard !codes.isEmpty else { return [] }
        let span = Double(night.endUnix - night.startUnix)
        let step = span / Double(codes.count)
        let origin = Double(night.startUnix)
        var result: [Block] = []
        var runStart = 0
        for index in 1...codes.count {
            if index == codes.count || codes[index] != codes[runStart] {
                if let stage = SleepStage(rawValue: Int(codes[runStart])) {
                    result.append(Block(
                        id: runStart,
                        stage: stage,
                        start: Date(timeIntervalSince1970: origin + Double(runStart) * step),
                        end: Date(timeIntervalSince1970: origin + Double(index) * step)
                    ))
                }
                runStart = index
            }
        }
        return result
    }

    var body: some View {
        Chart(blocks) { block in
            RectangleMark(
                xStart: .value("Start", block.start),
                xEnd: .value("End", block.end),
                y: .value("Stage", block.stage.name)
            )
            .foregroundStyle(block.stage.color)
        }
        .chartYScale(domain: [SleepStage.awake, .rem, .light, .deep].map(\.name))
        .frame(height: 150)
    }
}

private struct StageBreakdown: View {
    let night: SleepNight

    private var rows: [(SleepStage, UInt32)] {
        [(.deep, night.deepS), (.light, night.lightS), (.rem, night.remS), (.awake, night.awakeS)]
    }

    var body: some View {
        VStack(spacing: 6) {
            ForEach(rows, id: \.0) { stage, seconds in
                HStack {
                    Circle().fill(stage.color).frame(width: 10, height: 10)
                    Text(stage.name)
                    Spacer()
                    Text(formatDuration(seconds: seconds))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .font(.callout)
            }
        }
    }
}
