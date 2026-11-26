/**
 * A page that threw: the app's error state instead of a blank screen, with
 * a way back. (Route-level, so the sidebar and other pages keep working.)
 */
import { useEffect } from "react";
import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";
import { Button, EmptyState } from "../design/components";
import { trackError } from "../state/analytics";

export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  if (import.meta.env.DEV) console.error(error);
  // Reported to client_errors (state/analytics.ts), once a visit per message.
  useEffect(() => trackError(isRouteErrorResponse(error) ? `Route ${error.status} ${error.statusText}` : error), [error]);
  return (
    <div role="alert">
      <EmptyState
        level={1}
        icon="wifiSlash"
        title="Something Went Wrong"
        message="This page hit a problem. Try again, or go back to the scores."
        actions={
          <>
            <Button onClick={() => window.location.reload()}>Try Again</Button>
            <Button onClick={() => navigate("/")}>Back to Scores</Button>
          </>
        }
      />
    </div>
  );
}
