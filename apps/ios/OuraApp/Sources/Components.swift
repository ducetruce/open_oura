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
}

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
