import SwiftUI

struct ContentView: View {
    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("Caricamento fixture")
                .font(.title2)
            Text(version)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
