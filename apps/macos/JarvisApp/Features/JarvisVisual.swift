import AppKit
import SwiftUI

/// A small, opaque content surface that follows the macOS appearance and accent.
enum JarvisVisual {
    static let canvas = Color(nsColor: .windowBackgroundColor)
    static let surface = Color(nsColor: .controlBackgroundColor)
    static let border = Color(nsColor: .separatorColor)
}

extension View {
    func jarvisSurface(highlighted: Bool = false) -> some View {
        self
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                highlighted ? Color.accentColor.opacity(0.08) : JarvisVisual.surface,
                in: RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(highlighted ? Color.accentColor.opacity(0.35) : JarvisVisual.border)
            }
    }
}

struct JarvisStatusBadge: View {
    let title: String
    let symbol: String
    let color: Color

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.11), in: Capsule())
    }
}
