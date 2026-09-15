# Claude Research Connection

> Update: use the [Settings UI](SETTINGS.md) to save an encrypted API key and model without restarting. The .env setup below remains supported.

The Research stage now supports Anthropic's Claude Messages API with optional native web search and citations. Other creative stages still use the local starter generators. API connections are implemented through a provider adapter.

## Setup

1. Create an Anthropic API key in https://platform.claude.com/ and enable API billing. Claude chat subscriptions and API usage are separate products.
2. In the workspace, copy .env.example to .env if you do not already have a .env file. Otherwise add the two settings to your existing file.
3. Set ANTHROPIC_API_KEY to your real key. Set ANTHROPIC_MODEL to a model available to your account (the example uses claude-sonnet-5).
4. Stop the old server with Ctrl+C and restart with npm.cmd run dev. Open http://localhost:3000 and reload the page.
5. Open your project and choose the Research view. Select Claude and press Test Claude connection. That checks key and model access without generating content.
6. Choose web search and whether to share selected knowledge material, then press Generate Research. Confirmed brief and material gates still apply to existing projects.

Keep the key only in the local .env file or server environment. The server reads supported .env settings at startup; environment variables take precedence. Keys are not returned to the browser, stored in project files, or included in provider errors. The .env file is ignored by git.

## What is sent

The confirmed brief is sent to Anthropic when you generate with Claude. With the material option enabled, the request also contains selected Use knowledge notes, URL references and UTF-8 TXT/MD/CSV excerpts. Limits: 10,000 characters per item, 30,000 total. Truncation and excluded items are recorded in the saved provider result. URLs are references, not locally fetched pages. PDF/DOCX extraction, audio/video transcription, and image analysis are not implemented. Own material sharing is off by default.

## Results and review

Web search is enabled by default with up to five searches per request. Native citation references are preserved next to the returned text and displayed as clickable source links. Citations do not automatically verify a claim. If no citations are returned, the result is labelled an unsourced model draft. Search-tool warnings are visible even if the provider returns HTTP 200.

Research notes, source references, a review-required fact-check record, and provider metadata are saved. Successful regeneration archives previous files under research/history. Failed, empty, interrupted, or truncated provider responses leave the previous research unchanged. Overlapping generation and project edits are blocked while the request runs. Downstream work is marked for review after successful Claude research.

There is no offline fallback. A failed or unsourced response is reported as what it is, and the previous research is left unchanged rather than replaced with a draft.

## Troubleshooting

- Missing key: check .env location, add ANTHROPIC_API_KEY, restart the server.
- Rejected key: verify it in Claude Console and restart after replacing it.
- Model unavailable: change ANTHROPIC_MODEL to a model enabled for the account.
- Request rejected: check model access, credits and web-search organization settings. You may explicitly turn off search to generate an unsourced model draft.
- Rate limit or overload: retry later. There is no automatic retry that could create repeated charges.
- Timeout or unfinished answer: narrow the topic or retry. The current adapter does not automatically continue pause_turn responses.

The connection test does not guarantee available credits or web-search permission. Research requests can incur token and web-search charges.

## Validation

npm.cmd test includes mocked provider tests for credentials, configuration, citations, search errors, unfinished results, history preservation, optional own-material context, API errors, and overlapping edits. No paid provider requests were used during implementation; complete Test Claude connection after configuring your own key.

## Official references

- https://platform.claude.com/docs/en/get-started
- https://platform.claude.com/docs/en/models/overview
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console
