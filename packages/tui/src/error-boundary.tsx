import React from "react";
import { Box, Text } from "ink";
import { sanitizeTerminalText } from "./terminal-text.js";

interface Props {
  children: React.ReactNode;
  onError?: (error: Error, componentStack: string) => void;
}

interface State {
  error?: Error;
}

/** Last-resort render boundary: keep the terminal usable and preserve diagnostics. */
export class TuiErrorBoundary extends React.Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info.componentStack ?? "");
  }

  override render(): React.ReactNode {
    const error = this.state.error;
    if (!error) return this.props.children;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red" bold>
          AniCode TUI encountered an unexpected rendering error.
        </Text>
        <Text>{sanitizeTerminalText(error.message)}</Text>
        <Text dimColor>Press Ctrl+C to exit, then inspect --debug-log before restarting.</Text>
      </Box>
    );
  }
}
