# Design notes

Why this demo is shaped the way it is. The runbook and the current state live
in [README.md](README.md); this file is the reasoning behind the choices.

## The story

Three beats, in this order:

1. An ordinary app on Postgres. It lives, it has data, it has no AI.
2. One call, and it has conversational AI over its own data.
3. Only then do we open Quill and show the configuration behind it.

The order matters. Showing the configuration first turns the demo into a
walkthrough of forms. Showing the result first makes the configuration look
small, which is the actual claim.

## Why a food delivery marketplace

The domain has to give the model four things at once: numbers, time, geography
and free text. Reviews are what makes the answers sound like a conclusion a
person reached rather than a report a query printed.

The app is deliberately Node and Express, not RavenDB and not .NET. The
audience should see somebody else's ordinary app, not our product wearing a
costume.

## Why the data is planted

A demo over random data produces answers nobody can check and nobody finds
interesting. So three specific truths are seeded, each requiring a different
kind of reasoning:

- **Friday in Riverside** needs three tables joined and reviews read. The cause
  is split between the kitchen and courier staffing, so a single-cause answer
  is wrong. This is the flagship question.
- **The trap dish** needs margin compared across a menu and then cross-checked
  against ratings. Two different sources, one conclusion.
- **The two-faced courier** needs the search to start from the symptom. Walking
  the courier list one by one does not find it in reasonable time.

The generator is deterministic and self-verifying. If a story fails to appear
in the data, the load fails rather than producing a demo that quietly does not
work.

## Why the agent is written by hand

`suggest/agent` would have been the natural choice, and generating the RQL from
Quill's own view of the collections would have guaranteed the queries matched
the schema. It does not work on this instance: it calls RavenDB's hosted AI
Helper rather than our model connection, and that returns 401.

So the tools are hand-written, and the system prompt carries workarounds for
several behaviours that fail silently. See findings 4, 5, 6, 10 and 11 in the
README. Without those workarounds the same model on the same data answers
confidently and wrongly.

## Why the chat appears in two places

One click mints two independent embed links: one drives a bubble inside the
app, one is embedded directly in the pilot page. Same agent, same data, two
surfaces. It makes the point that the channel is not welded to one host page,
and it means the presenter can demonstrate without switching tabs.

## Why the button does real work

No recorded fallback, by choice. The button calls the app backend, which calls
Quill's `embed-links` endpoint with the API key server side. The raw response
and the timing are printed underneath. An audience can tell the difference
between a live call and an animation, and the timing is the punchline.

The Quill configuration itself (source, mapping, model, agent, channel) is done
*before* the demo. That is deliberate: waiting for an ingest on stage would kill
the pacing, and the demo is about the result, not the wizard.

## Deliberate leftovers

The database, its users and the app slug are still named `zjadlo` from the
first draft, which was in Polish. They were not renamed because renaming them
forces a full reprovision of the Quill app for zero visible benefit. Nothing
the audience sees mentions them.
