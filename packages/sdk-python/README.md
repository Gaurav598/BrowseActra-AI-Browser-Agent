<p align="center"><img src="../../media/browseactra-mark.svg" alt="BrowseActra" width="80" height="80"></p>

# BrowseActra: Python SDK

BrowseActra independently maintains an imported Stagehand browser automation foundation. This SDK retains its existing `stagehand` package/module and API names for compatibility. BrowseActra is not affiliated with Browserbase. See the [project overview](../../README.md), [upstream attribution](../../UPSTREAM.md), and [MIT license](../../LICENSE).

The Python SDK supports local Chrome and optional Browserbase-backed browser sessions, natural-language `act()` and `observe()`, structured `extract()`, and direct page/locator operations. Model-backed examples need an API key. Existing Browserbase cloud services are external integrations that need separate credentials.

## Example

The async Python SDK for Stagehand browser automation:

```python
import asyncio
import os

from pydantic import BaseModel

from stagehand import Stagehand, browserbase, local_browser


class PullRequest(BaseModel):
    author: str
    title: str


async def main() -> None:
    browser = await local_browser.launch(headless=True)
    try:
        stagehand = await Stagehand.create(
            browser=browser,
            model="openai/gpt-5.4-mini",
            model_api_key=os.environ["OPENAI_API_KEY"],
        )
        try:
            page = (await browser.context.pages())[0]
            await page.goto("https://github.com/browserbase")

            # act() executes individual actions
            await stagehand.act("click on the stagehand repo")

            # observe() reports what is actionable on the page
            observed = await stagehand.observe("find the latest PR")

            # Locators give deterministic, Playwright-style actions
            await page.locator(observed.data[0].selector).click()

            # extract() returns structured data validated by a pydantic model
            result = await stagehand.extract(
                "extract the author and title of the PR",
                PullRequest,
            )
            print(result.data.author, result.data.title)
        finally:
            await stagehand.close()
    finally:
        await browser.close()


asyncio.run(main())
```

See [`examples`](examples) for action, extraction, observation, and custom LLM usage.

For hosted browsers, import `browserbase` from `stagehand` and use
`browserbase.launch(api_key=...)` or `browserbase.connect(api_key=..., session_id=...)` instead of
`local_browser`. Calling `close()` on the browser handle releases the Browserbase session. To keep
a `keep_alive=True` session for later, call `stagehand.close()` without `browser.close()`.

The same `browserbase` facade exposes Browserbase Search and Fetch without launching a browser:

```python
import asyncio
import os

from stagehand import browserbase


async def search_and_fetch() -> None:
    results = await browserbase.search(
        api_key=os.environ["BROWSERBASE_API_KEY"],
        query="browser agent frameworks",
        num_results=5,
    )
    fetched = await browserbase.fetch(
        api_key=os.environ["BROWSERBASE_API_KEY"],
        url=results.results[0].url,
        format="markdown",
    )
    print(fetched.content)


asyncio.run(search_and_fetch())
```

`Stagehand.act()`, `Stagehand.observe()`, and `Stagehand.extract()` use the active page by
default. Pass `page=page` to target a specific SDK `Page`.

`Page.goto()`, `reload()`, `go_back()`, and `go_forward()` return the main-document `Response`,
or `None` when navigation does not produce one. Response bodies and complete headers are retrieved
lazily while the Stagehand session remains open.

When contributing examples or tests, keep browser ownership explicit: launch or connect a
browser handle, pass it to `Stagehand.create()`, close Stagehand first, and close the browser in
the outermost `finally` block.

## Contributing

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install just
brew install just

just install
just generate
just check
just test
just build
```
