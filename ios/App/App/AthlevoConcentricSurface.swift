import SwiftUI

/// Athlevo's shared "concentric surface" shape system.
///
/// Athlevo's iOS app is currently a Capacitor/WKWebView shell — `AppDelegate.swift`
/// is UIKit, and there are no SwiftUI view hierarchies in the native target today.
/// `ConcentricRectangle` (iOS 26+) only means something as a *shape*, and shapes only
/// exist inside SwiftUI, so this file has nothing to attach to yet. It exists as
/// ready-to-use infra for the first native SwiftUI surface Athlevo ships (a native
/// bottom sheet, a native overlay near the screen edge, etc.) so that surface can
/// opt into concentric corners on iOS 26+ without re-deriving this logic, while
/// staying visually identical to Athlevo's current rounded-rectangle language on
/// older versions.
///
/// Nothing here is referenced by AppDelegate.swift or any other file in the target
/// yet — adding it does not change app behavior, does not raise the deployment
/// target (still iOS 15.0, see App.xcodeproj), and does not introduce any new
/// SwiftUI view into the app.
enum AthlevoSurfaceRadius {
    /// Matches the web design system's `--r-lg` card radius (see index.html),
    /// kept as the fallback/base radius so a future native surface stays close
    /// to Athlevo's existing rounded-rectangle language.
    static let base: CGFloat = 22
}

/// Returns the shape a native "edge surface" (a view whose corners are meant to
/// read as concentric with the screen or a parent container's edge) should use.
///
/// - iOS 26+: a real `ConcentricRectangle`, so the corner radius is derived from
///   the containing shape (the device's screen corners, or an ancestor's
///   `containerShape`) instead of a hardcoded value.
/// - iOS < 26: falls back to a continuous `RoundedRectangle` at `radius`, which is
///   what Athlevo's surfaces already use today — visually unchanged.
///
/// Ordinary internal cards (score cards, athlete status, settings rows, pricing
/// cards, etc.) should NOT use this — they keep their existing fixed-radius
/// styling. Only reach for this when a view's corners genuinely relate to a
/// containing device/container edge.
@ViewBuilder
func athlevoConcentricShape(fallbackRadius: CGFloat = AthlevoSurfaceRadius.base) -> some Shape {
    if #available(iOS 26.0, *) {
        ConcentricRectangle()
    } else {
        RoundedRectangle(cornerRadius: fallbackRadius, style: .continuous)
    }
}

/// View-modifier convenience for clipping/backgrounding a native edge surface with
/// `athlevoConcentricShape(fallbackRadius:)`. Kept separate from the shape helper
/// above so a caller that only needs the `Shape` (e.g. for a stroke) isn't forced
/// through a modifier.
struct AthlevoConcentricSurface: ViewModifier {
    var fallbackRadius: CGFloat = AthlevoSurfaceRadius.base

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.clipShape(ConcentricRectangle())
        } else {
            content.clipShape(RoundedRectangle(cornerRadius: fallbackRadius, style: .continuous))
        }
    }
}

extension View {
    /// Applies Athlevo's concentric-or-fallback edge-surface clipping. See
    /// `AthlevoConcentricSurface` for when this is (and isn't) appropriate.
    func athlevoConcentricSurface(fallbackRadius: CGFloat = AthlevoSurfaceRadius.base) -> some View {
        modifier(AthlevoConcentricSurface(fallbackRadius: fallbackRadius))
    }
}
