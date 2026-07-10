import SwiftUI
import VisionKit

/// QR scanner sheet for wn://pair codes (Setup → Scan QR). Wraps VisionKit's
/// DataScannerViewController limited to QR symbology; fires `onScan` with the
/// first payload and stops. Unsupported hardware (simulator, no camera,
/// camera restricted) shows a hint to use the paste flow instead.
struct QRScannerSheet: View {
    let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    QRScannerView { payload in
                        onScan(payload)
                        dismiss()
                    }
                    .ignoresSafeArea()
                } else {
                    ContentUnavailableView(
                        "Camera unavailable",
                        systemImage: "qrcode.viewfinder",
                        description: Text("Scanning isn't available on this device. Copy the wn://pair link and use \"Paste pairing link\" instead.")
                    )
                }
            }
            .navigationTitle("Scan pairing code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

private struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .fast,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        guard !scanner.isScanning else { return }
        try? scanner.startScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        private var fired = false

        init(onScan: @escaping (String) -> Void) {
            self.onScan = onScan
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd added: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !fired else { return }
            for item in added {
                if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue, !payload.isEmpty {
                    fired = true
                    scanner.stopScanning()
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    onScan(payload)
                    return
                }
            }
        }
    }
}
