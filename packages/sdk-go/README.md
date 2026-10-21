<p align="center"><img src="../../media/browseactra-mark.svg" alt="BrowseActra" width="80" height="80"></p>

# BrowseActra: Go SDK

BrowseActra independently maintains an imported Stagehand browser automation foundation. This SDK retains its existing `stagehand` package/module and API names for compatibility. BrowseActra is not affiliated with Browserbase. See the [project overview](../../README.md), [upstream attribution](../../UPSTREAM.md), and [MIT license](../../LICENSE).

The Go SDK supports local Chrome and optional Browserbase-backed browser sessions, natural-language `act()` and `observe()`, structured `extract()`, and direct page/locator operations. Model-backed examples need an API key. Existing Browserbase cloud services are external integrations that need separate credentials.

## Example

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"

	stagehand "github.com/browserbase/stagehand/packages/sdk-go/v4"
)

type pullRequest struct {
	Author string `json:"author"`
	Title  string `json:"title"`
}

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) (err error) {
	browser, err := stagehand.LaunchLocalBrowser(ctx, &stagehand.LocalBrowserLaunchOptions{Headless: true})
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, browser.Close(ctx)) }()

	modelAPIKey := os.Getenv("OPENAI_API_KEY")
	client, err := stagehand.Create(ctx, stagehand.CreateOptions{
		Browser: browser,
		Model: &stagehand.ModelConfig{
			ModelName: "openai/gpt-5.4-mini",
			APIKey:    &modelAPIKey,
		},
	})
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, client.Close(ctx)) }()

	browserContext, err := browser.Context()
	if err != nil {
		return err
	}
	pages, err := browserContext.Pages(ctx)
	if err != nil {
		return err
	}
	page := pages[0]
	if _, err := page.Goto(ctx, "https://github.com/browserbase", nil); err != nil {
		return err
	}

	// Act executes individual actions
	if _, err := client.Act(ctx, stagehand.ActInstruction("click on the stagehand repo"), nil); err != nil {
		return err
	}

	// Observe reports what is actionable on the page
	instruction := "find the latest PR"
	observed, err := client.Observe(ctx, &instruction, nil)
	if err != nil {
		return err
	}

	// Locators give deterministic, Playwright-style actions
	if err := page.Locator(observed.Data[0].Selector).Click(ctx, nil); err != nil {
		return err
	}

	// Extract returns structured data decoded into a Go type
	extracted, err := stagehand.Extract[pullRequest](
		ctx,
		client,
		"extract the author and title of the PR",
		nil,
	)
	if err != nil {
		return err
	}
	fmt.Println(extracted.Data.Author, extracted.Data.Title)

	return nil
}
```

Browserbase Search and Fetch are also available without launching a browser:

```go
numResults := 5
results, err := stagehand.SearchBrowserbase(ctx, stagehand.BrowserbaseSearchOptions{
	APIKey: os.Getenv("BROWSERBASE_API_KEY"),
	Query: "browser agent frameworks",
	NumResults: &numResults,
})
if err != nil {
	return err
}
if len(results.Results) == 0 {
	return fmt.Errorf("search returned no results")
}
fetched, err := stagehand.FetchBrowserbase(ctx, stagehand.BrowserbaseFetchOptions{
	APIKey: os.Getenv("BROWSERBASE_API_KEY"),
	URL: results.Results[0].URL,
	Format: stagehand.BrowserbaseFetchFormatMarkdown,
})
if err != nil {
	return err
}
content, ok := fetched.Content.AsString()
if !ok {
	return fmt.Errorf("fetch returned non-string content")
}
fmt.Println(content)
```

## Navigation

Navigation methods return the main-document response when the browser performs a network request:

```go
response, err := page.Goto(ctx, "https://example.com", nil)
if err != nil {
	return err
}
if response != nil {
	body, err := response.Body(ctx)
	if err != nil {
		return err
	}
	fmt.Println(response.Status(), string(body))
}
```

`Reload`, `GoBack`, and `GoForward` use the same `(*Response, error)` pattern. A successful
navigation without a main-document network response returns `(nil, nil)`. Response bodies and
complete headers are retrieved lazily while the Stagehand session remains open.

## Extraction

Define the output as a Go type and call the package-level generic function. Stagehand derives the JSON Schema from the type and returns decoded data with the usual result metadata:

```go
type story struct {
	Title  string `json:"title"`
	Points int    `json:"points"`
}

type stories struct {
	Stories []story `json:"stories"`
}

result, err := stagehand.Extract[stories](ctx, sh, "Extract the top 5 stories", nil)
if err != nil {
	return err
}
fmt.Println(result.Data.Stories)
```

Fields omitted with `json:",omitempty"` are optional in the generated schema. Add constraints such as `jsonschema:"format=uri"` or `jsonschema:"description=the displayed price"` when the Go type alone is not specific enough.

## More Examples

Run the flat examples directly from the repository:

```sh
go -C packages/sdk-go run examples/act.go
go -C packages/sdk-go run examples/extract.go
```
