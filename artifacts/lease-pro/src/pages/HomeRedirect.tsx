import { Show } from "@clerk/react";
import { Redirect } from "wouter";

export function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/chat" />
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}
