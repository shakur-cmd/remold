import { Component, type ReactNode } from "react";
import { Link } from "react-router";
import { errorMessage } from "@/lib/errors";

type Props = { children: ReactNode; resetKey: string };
type State = { error: unknown };

// A malformed id in the URL makes a Convex query throw during render; show a
// way out instead of a blank page. Re-keyed on navigation so the next route retries.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }
  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto grid max-w-md gap-3 px-4 py-16 text-center">
        <p className="font-medium">That link did not work.</p>
        <p className="text-sm text-muted-foreground">{errorMessage(this.state.error)}</p>
        <Link to="/" className="text-sm underline">
          Go to my organisations
        </Link>
      </div>
    );
  }
}
