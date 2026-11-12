import Charts
import SwiftUI

// MARK: Formatting

func formatDuration(seconds: UInt32) -> String {
    let minutes = Int(seconds) / 60
    return "\(minutes / 60)h \(String(format: "%02d", minutes % 60))m"
}

func formatValue(_ value: Double?, digits: Int = 0) -> String {
    guard let value else { return "–" }
    return String(format: "%.\(digits)f", value)
}

func dateFromUnix(_ unix: Int64) -> Date {
    Date(timeIntervalSince1970: TimeInterval(unix))
}

extension DaySummary {
    /// Noon of this local day, for labels and chart positions.
    var midday: Date { dateFromUnix(dayStartUnix + 12 * 3600) }

    var title: String {
        midday.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }

    var sleepScoreValue: Double? { sleep?.sleepScore.map { Double($0.value) } }
    var readinessScoreValue: Double? { sleep?.readinessScore.map { Double($0.value) } }
}

/// Shown wherever a score appears: these are not Oura's numbers.
let scoreDisclaimer = "Estimates. They combine Oura’s contributor weights with this app’s own curves, so they will not match the official app."

// MARK: Sleep stages

enum SleepStage: Int, CaseIterable {
    case deep = 0, light, rem, awake

    var name: String {
        switch self {
        case .deep: "Deep"
        case .light: "Light"
        case .rem: "REM"
        case .awake: "Awake"
        }
    }

    var color: Color {
        switch self {
        case .deep: .indigo
        case .light: .blue
        case .rem: .teal
        case .awake: .orange
        }
    }
}

// MARK: Building blocks

struct MetricCard: View {
    let title: String
    let value: String
    var unit: String = ""
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.caption)
                .foregroundStyle(tint)
                .lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
                if !unit.isEmpty && value != "–" {
                    Text(unit)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

struct Card<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// A 0–100 score as a ring. Shows a dash while the score is unavailable.
struct ScoreRing: View {
    let title: String
    let score: Score?
    let tint: Color

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle().stroke(tint.opacity(0.2), lineWidth: 10)
                Circle()
                    .trim(from: 0, to: CGFloat(score?.value ?? 0) / 100)
                    .stroke(tint, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text(score.map { String($0.value) } ?? "–")
                    .font(.title.weight(.semibold))
                    .monospacedDigit()
            }
            .frame(width: 96, height: 96)
            Text(title).font(.subheadline)
            Text(score?.provisional == true ? "Provisional" : " ")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(spokenValue)
    }

    private var spokenValue: String {
        guard let score else { return "Not available" }
        return score.provisional ? "\(score.value), provisional" : String(score.value)
    }
}

/// What went into a score: one bar per contributor.
struct ContributorList: View {
    let score: Score
    let tint: Color

    var body: some View {
        VStack(spacing: 10) {
            ForEach(score.contributors, id: \.name) { contributor in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(contributor.name)
                        Spacer()
                        Text(String(contributor.score))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    ProgressView(value: Double(contributor.score), total: 100)
                        .tint(tint)
                }
                .font(.callout)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// A line chart of one timestamped series.
struct SeriesChart: View {
    let points: [Point]
    let unit: String
    let tint: Color

    var body: some View {
        Chart {
            ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                LineMark(
                    x: .value("Time", dateFromUnix(point.unix)),
                    y: .value(unit, point.value)
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(tint)
            }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .frame(height: 160)
    }
}
