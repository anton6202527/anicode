import React from "react";
import { render } from "ink";
import { App, type AppProps } from "./app.js";
import { TuiErrorBoundary } from "./error-boundary.js";

export type InteractiveTuiInstance = ReturnType<typeof render>;

export interface InteractiveTuiOptions {
  appProps: AppProps;
  output: NodeJS.WriteStream;
  alternateScreen: boolean;
  screenReader: boolean;
  incrementalRendering: boolean;
  onError?: (error: Error, componentStack: string) => void;
}

/** Keep React/Ink outside the headless CLI startup graph until a real TTY is ready to render. */
export function renderInteractiveTui(options: InteractiveTuiOptions): InteractiveTuiInstance {
  return render(
    <TuiErrorBoundary {...(options.onError ? { onError: options.onError } : {})}>
      <App {...options.appProps} />
    </TuiErrorBoundary>,
    {
      stdout: options.output,
      alternateScreen: options.alternateScreen,
      // Ink 7 only invalidates its incremental line cache when terminal width shrinks.
      // Complete frames make resize reset + repaint atomic across both dimensions.
      incrementalRendering: options.incrementalRendering,
      isScreenReaderEnabled: options.screenReader,
      // Ink otherwise disables input whenever CI=1, even for a real PTY.
      interactive: process.stdin.isTTY === true,
      maxFps: 30,
    },
  );
}
