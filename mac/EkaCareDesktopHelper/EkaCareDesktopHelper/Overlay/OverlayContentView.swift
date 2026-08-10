//
//  OverlayContentView.swift
//  EkaCareDesktopHelper
//
//  Created by Lourdes Dinesh on 3/13/26.
//

import SwiftUI
import Combine
import AppKit

struct OverlayContentView: View {
  @EnvironmentObject private var appState: BridgeAppState
  @EnvironmentObject private var overlayStateStore: OverlayStateStore
  
  var body: some View {
    VStack {
      switch overlayStateStore.presentation {
      case .hidden:
        EmptyView()
      case .prompt:
        PromptOverlayView(
          appName: overlayStateStore.promptTriggeringApp,
          onStart: { appState.startRecordingTapped() },
          onDismiss: { appState.dismissOverlayPrompt() },
          onOpenApp: { appState.openMainAppTapped() }
        )
      case .recording:
        let isPaused: Bool = { if case .recording(let p) = appState.phase { return p }; return false }()
        RecordingOverlayView(
          isPaused: isPaused,
          onPauseToggle: {
            if case .recording(let p) = appState.phase, p {
              appState.resumeRecording()
            } else {
              appState.pauseRecording()
            }
          },
          onStop: { appState.stopRecordingTapped() },
          onDismiss: { appState.dismissOverlayPrompt() },
          onOpenApp: { appState.openMainAppTapped() }
        )
      case .processing:
        ProcessingOverlayView(
          onDismiss: { appState.dismissOverlayPrompt() },
          onOpenApp: { appState.openMainAppTapped() }
        )
      case .processed(let transactionId):
        ProcessedOverlayView(
          transactionId: transactionId,
          onView: { appState.emitScribeResultView(transactionId: transactionId) },
          onDismiss: { appState.dismissOverlayPrompt() },
          onOpenApp: { appState.openMainAppTapped() }
        )
      case .error(let message):
        ErrorOverlayView(
          message: message,
          onView: { appState.viewErrorTapped() },
          onDismiss: { appState.dismissOverlayPrompt() },
          onOpenApp: { appState.openMainAppTapped() }
        )
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .animation(.spring(response: 0.25, dampingFraction: 0.85), value: overlayStateStore.presentation)
  }
}

struct IconRingButtonStyle: ButtonStyle {
  let strokeColor: Color
  
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .frame(width: 16, height: 16)
      .padding(4)
      .background(
        RoundedRectangle(cornerRadius: 4, style: .continuous)
          .stroke(strokeColor, lineWidth: 1)
      )
      .frame(width: 36, height: 36)
      .contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.8 : 1)
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

struct OverlayCloseButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(
        Circle()
          .fill(Color.black)
      )
      .overlay(
        Circle()
          .stroke(Color.white.opacity(0.25), lineWidth: 1)
      )
      .opacity(configuration.isPressed ? 0.8 : 1)
      .scaleEffect(configuration.isPressed ? 0.95 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

struct OverlayContainer<Content: View>: View {
  private let closeButtonSize: CGFloat = 18
  private let closeButtonOverlap: CGFloat = 9
  
  let onDismiss: () -> Void
  let closeButtonVisible: Bool
  let content: Content
  
  init(
    onDismiss: @escaping () -> Void,
    closeButtonVisible: Bool = true,
    @ViewBuilder content: () -> Content
  ) {
    self.onDismiss = onDismiss
    self.closeButtonVisible = closeButtonVisible
    self.content = content()
  }
  
  var body: some View {
    ZStack(alignment: .topLeading) {
      content
      
      Button(action: onDismiss) {
        Image(systemName: "xmark")
          .font(.system(size: 9, weight: .semibold))
          .foregroundColor(Color(red: 156/255, green: 163/255, blue: 175/255))
          .frame(width: closeButtonSize, height: closeButtonSize)
      }
      .buttonStyle(OverlayCloseButtonStyle())
      .focusable(false)
      .opacity(closeButtonVisible ? 1 : 0)
      .offset(x: -closeButtonOverlap, y: -closeButtonOverlap)
      .allowsHitTesting(closeButtonVisible)
      .accessibilityLabel("Dismiss overlay")
    }
    .padding(.top, closeButtonOverlap)
    .padding(.leading, closeButtonOverlap)
    .padding(.trailing, closeButtonOverlap)
  }
}

struct OverlayCard<Content: View>: View {
  let content: Content
  let backgroundColor: Color
  let width: CGFloat?
  
  init(
    width: CGFloat? = 300,
    backgroundColor: Color = Color(red: 11/255, green: 14/255, blue: 20/255).opacity(0.96),
    @ViewBuilder content: () -> Content
  ) {
    self.width = width
    self.backgroundColor = backgroundColor
    self.content = content()
  }
  
  var body: some View {
    content
      .frame(width: width)
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(backgroundColor)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .strokeBorder(Color.white.opacity(0.07), lineWidth: 1)
      )

  }
}

struct OverlayPromptProgressViewStyle: ProgressViewStyle {
  let trackColor: Color
  let fillColor: Color
  
  init(
    trackColor: Color = Color.white.opacity(0.08),
    fillColor: Color = Color.blue
  ) {
    self.trackColor = trackColor
    self.fillColor = fillColor
  }
  
  func makeBody(configuration: Configuration) -> some View {
    GeometryReader { geometry in
      let progress = configuration.fractionCompleted ?? 0
      
      ZStack(alignment: .leading) {
        Rectangle()
          .fill(trackColor)
        
        Rectangle()
          .fill(fillColor)
          .frame(width: geometry.size.width * progress)
      }
    }
    .clipped()
  }
}

struct PrimaryPillButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .semibold))
      .foregroundColor(.white)
      .frame(maxWidth: .infinity)
      .frame(height: 34)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(Color(red: 0.20, green: 0.55, blue: 1.0))
      )
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

struct GhostPillButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .semibold))
      .foregroundColor(Color.white.opacity(0.9))
      .frame(maxWidth: .infinity)
      .frame(height: 34)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(Color.white.opacity(configuration.isPressed ? 0.12 : 0.07))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(Color.white.opacity(0.12), lineWidth: 1)
      )
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

struct PromptStartSplitButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .medium))
      .foregroundColor(.white)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Color(hex: "#215FFF"))
      )
      .opacity(configuration.isPressed ? 0.9 : 1)
      .scaleEffect(configuration.isPressed ? 0.985 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
