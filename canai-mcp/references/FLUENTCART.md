# FluentCart store (plugin v1.103.0; attributes, buy-section switches, slugs and shipping helpers v1.105.0; store tools v1.106.0; checkout mode, attribute library, stock, subscriptions, deleting and re-pricing v1.107.0)

Use this reference when the site sells with **FluentCart** and the user wants its product pages,
shop, category or brand archives, cart, checkout, receipt or customer account designed in CanAI.
The workflow is under **Workflow** below; this file holds the types, the Twig
functions, the data and the rules.

**CanAI renders pages, FluentCart owns commerce.** CanAI calls FluentCart's own renderers for
everything a shopper clicks and reads product data to display it. Rendering never writes a cart, an
order or a product. Products, store settings, store pages and shipping change only through the
store tools (see **Store tools**), once the owner turns them on, and the starter preset (see
**Starter preset**). The support
is on only while FluentCart **1.6.6 or later** is active with its product renderer:
`wpcanai-get-fluent-cart-pages` is in your tool list then, and `wpcanai-diagnostics`
group `wordpress` row `fluentcart` reads "Active <version>". Without it, no `fct_*` function, type
or tool exists.
On a site that also sells with WooCommerce, its pages keep WooCommerce's own types: read
[WOOCOMMERCE.md](WOOCOMMERCE.md) for those.

## Rules

1. **Text from `post`, live pieces from the helpers.** Print the title and description from `post`
   (`{{ post.post_title }}`, `{{ the_content(post.post_content) }}`): CanAI's per-language content
   overrides apply to `post`, while FluentCart's renderers print the stored title. Use the `fct_*`
   helpers for the gallery, prices, buy section, buttons, mini cart, shop app, cart, checkout,
   receipt and account. They apply FluentCart's catalog mode, stock and subscription rules and
   carry the markup its JavaScript binds to.
2. **Reviews follow `the_content`.** On a product page FluentCart appends its after-product content
   (the reviews, on 2.x with a classic theme) to every `the_content()` output, whatever content you
   pass. Call `the_content()` once, for the description, where the reviews belong.
3. **One checkout per page.** FluentCart's checkout script boots on one checkout. Print
   `fct_checkout_page()` once, on the checkout page (its `fct-checkout` template or its own
   `_canai_html`); the same goes for `fct_cart_page()` on the cart page.
4. **Never hand-build the checkout or the cart.** The checkout binds to dozens of FluentCart
   `data-*` hooks, and the cart's markup is replaced by server fragments after every change. Place
   `fct_checkout_page()` / `fct_cart_page()` (or the page's shortcode through
   `the_content(post.post_content)`) and style around them.
5. **A product page needs a way to buy.** CanAI switches off FluentCart's own product header on the
   pages it renders, so a `single-fluent-products` template, or a product's own `_canai_html`, must
   print `fct_buy_section()`, `fct_product_page()` or a button helper. `wpcanai-scan` reports one
   without as `fct_product_no_buy`.
6. **Orders, customers and the rest of the store's data are not CanAI's.** Orders, customers,
   subscriptions, coupons and reports live on FluentCart's own MCP server
   (`/wp-json/fluent-cart/mcp`). It is off until the owner turns on "MCP for AI Agents" in
   FluentCart → Settings → Features & addon, and needs a WordPress user with a FluentCart role. Say
   so; don't look for those tools on CanAI's server. Products (stock and subscriptions included),
   attributes, prices, store settings and shipping go through CanAI's store tools only while the
   owner has turned their areas on (see **Store tools**); tax, payment methods, coupons and orders
   stay in FluentCart.

## Workflow

1. **Get the pages.** `wpcanai-get-fluent-cart-pages { }`: each store page's `type`, `id`, `url`, `status`, `has_canai_html` and `renders_store`, the `product_base`, a sample archive URL per taxonomy, and sample products. An `id` of 0 means FluentCart has no page set: set it with `wpcanai-update-fluent-cart-settings { "pages": { "cart": "create" } }` (FluentCart's own page) or a published page's id, when the store-settings area is on; otherwise the owner chooses it in FluentCart → Settings → Store Settings → Pages Setup.
2. **Resolve.** `wpcanai-resolve-content-id { "type": "fct-checkout" }` (and each type you'll touch) says which post renders it; edit that `content_post_id`.
3. **Author.** Reuse the site's layout (it must print `wp_head()`, `wp_footer()` and `body_class()`); put a header cart in it (`fct_mini_cart()` or the badge pattern) with links from `fct_url('cart')` / `fct_url('checkout')`. Then the type templates with `wpcanai-create-template` (`single-fluent-products`, `fct-product-category`, `fct-shop`, and the store pages that need more than the layout around FluentCart's own piece), each with `layout` set to the layout's id: a type template draws the whole page, and `wpcanai_default_layout` doesn't wrap it. Print the store page's piece with its helper (`fct_checkout_page()`, …) or `the_content(post.post_content)`. `fct_*` shortcode helpers take a hash only where FluentCart reads one (the shop app's filter sidebar is `fct_shop_app({custom_filters: {…}})`); see **Shortcode attributes** below.
4. **Preview a product.** `wpcanai-preview-link { "post_id": <a products.sample id> }`, then screenshot it (see SKILL.md → **Check your work in a browser**); do the same for the shop page. An archive is a term, not a post, so it gets no link: open a `sample_term_url` in a plain browser. The cart, checkout, receipt, account and order-review pages refuse a link (`not_previewable`): open the published checkout's `url` in a plain logged-out browser to check the design around FluentCart's checkout, and ask the owner to check the account and receipt pages logged in.
5. **Scan.** `wpcanai-scan` must show no `fct_page_unset`, `fct_renderer_missing` or `fct_product_no_buy` (see SKILL.md → `wpcanai-scan`), and the delegate findings clean, as for WooCommerce. `get-fluent-cart-pages` `renders_store: false` on a page is the same signal.

## Starter preset

`fct-roastery` ("Ember & Bean", plugin v1.104.0) is a bundled coffee-roaster preset: 8 products
(`simple` and `simple_variations`, sale prices, a mug with an image per variation), 10 templates
(layout, header, footer and seven store templates), Home and About, and two menus. Install and uninstall it as SKILL.md → **Presets** says
(`needs_rerun`, `kept`). It is the worked example of the `fct_*` helpers. Where it's installed,
read its templates with `wpcanai-list-templates` and `wpcanai-read-meta`; the source is
`presets/fct-roastery/preset.json` in the CanAI plugin (`canai/presets/fct-roastery/preset.json`).

- **The shop card** (`fct-shop` and `fct-product-category` in one template): `post.fct.images[0]`,
  a `t('From {price}', …)` range, the compare price, a Sale badge from `price.on_sale`,
  `fct_add_to_cart_button(post, {text, class})` only when `post.fct.can_add_to_cart` and a
  "Choose options" or "View product" link otherwise, category chips from
  `wpcanai_get_terms_enriched()`, and `wpcanai_pagination()`.
- **The product template:** `fct_product_gallery()`, `fct_product_price()`, `fct_buy_section()`,
  the description through one `the_content(post.post_content)` inside the single `<article>`, and
  related products from `fct_get_products({category, per_page, exclude_ids})`.
- **The header mini cart:** `fct_mini_cart()` in `fct-header`, which the layout includes by a
  literal `wpcanai_template('fct-header')`, so its styles load in `<head>`.
- **The store templates:** `fct_cart_page()`, `fct_checkout_page()`, `fct_receipt_page()`,
  `fct_account_page()`, and order review's title above `the_content(post.post_content)`. Each
  typed template is inside `fct-layout`.

It doesn't use `fct_shop_app()`, `fct_product_page()`, `fct_product_card()` or the Buy Now helpers.

Over MCP (v1.107.0), installing or uninstalling it, or `clean_slate` while it is installed, needs all
three FluentCart store areas open in Guardrails (see **Store tools**) and FluentCart's permissions
(`products/delete` too for an uninstall or a clean slate); otherwise the call answers
`{success: false, code: "fct_writes_off"}` (or `fct_forbidden`). CanAI → Tools → Presets and WP-CLI don't ask: the owner
is there.

## Store tools (plugin v1.106.0; v1.107.0 additions marked)

Seven MCP tools set up a store without wp-admin: read it with `wpcanai-get-fluent-cart-store` and
`wpcanai-get-fluent-products`, change it with `wpcanai-update-fluent-cart-settings`,
`wpcanai-write-fluent-cart-shipping-zone`, `wpcanai-write-fluent-cart-shipping-class`,
`wpcanai-write-fluent-product` and **(v1.107.0)** `wpcanai-write-fluent-attribute-group`. They
write through FluentCart's own services, with its rules.

- **The Guardrails switch.** Every write needs its area ticked in **CanAI → AI Client →
  Guardrails → FluentCart store**: Products, Store settings and pages, Shipping. All are off by
  default. A closed area answers `fct_writes_off`; a user without FluentCart's permission
  `fct_forbidden`. `get-fluent-cart-store` → `writes` says which are open. Ask the owner to tick the
  area; never write FluentCart's data another way (snippets, `update-options`).
- **(v1.107.0) A closed area hides its tools** while the site follows tool recommendations (rule
  **R5**): they're missing from your tool list, `wpcanai-manage-tools` `list` shows them with
  `rule: "R5"` and the area to open, and they come back once the owner ticks it. Turning the tool on
  with `manage-tools` doesn't open the area; only the owner can.
- **(v1.107.0) A key whose WordPress user is gone** is refused (`fct_key_user_gone`): FluentCart's
  permissions belong to a person. The owner makes a new key.
- **Read first, write back.** Each read returns the shape its write takes. On an update only the
  keys you send change; the rest keep their stored values.
- **Money** is a decimal string in the store currency (`"150.00"`), as FluentCart's admin shows it.
- **Results** carry `warnings` and `notes`: report them to the owner.

### Store settings and pages

```json
{ "settings": { "currency": "MYR", "show_cart_icon_in_body": false, "store_country": "MY" },
  "pages": { "cart": "create", "receipt": 934 } }
```

- The allow-listed keys are `get-fluent-cart-store` → `allowed`: currency and its format
  (`currency_position`, `decimal_separator`), `show_cart_icon_in_body` (FluentCart's floating cart
  button; `false` for a store without a cart), `hide_coupon_field`, `store_name`, `store_logo` (an image
  attachment id or `null`), the store address and `store_country` (checkout also uses it as the
  shipping country when the address has none), `weight_unit`, `dimension_unit`, `product_slug` (the
  `/item/` URL base).
- **A currency change relabels prices**; FluentCart refuses it under 2.x multi-currency once orders
  exist (`currency_locked`). **(v1.107.0) `reprice` converts them** in the same call:

  ```json
  { "settings": { "currency": "MYR" }, "reprice": { "rate": 4.4, "round": "cent" } }
  ```

  `rate` is new units per old unit; `round` is `cent` (default) or `whole`. It converts every
  variation's price, compare price and cost, subscription signup fees, per-order, per-item and per-weight
  shipping amounts and weight-tier costs, and fixed shipping-class costs, in one transaction, and
  recomputes each product's price range. Percentage rates, fixed-amount coupons, orders and prices
  typed into page text keep their numbers: tell the owner about coupons. It needs the Products and
  Shipping areas too, and is skipped (`rejected`: `reprice` / `currency_refused`) when the call's
  currency isn't applied. **It runs once per currency:** a second conversion into the store's current
  currency (a retried call after a timeout, say) is skipped as `already_repriced` with the date and
  rate of the first; read the prices back, and send `"again": true` only if they really need a second
  conversion. Preview first with `{ "reprice": { "rate": 4.4, "dry_run": true } }`
  alone: `repriced` gives the counts and five examples, and nothing is written.
- Keys FluentCart doesn't read (`show_cart_icon_in_nav`, `thousand_separator`, the button texts) are
  refused with the reason. Order mode, payments, tax and invoices aren't on the allowlist.
- `pages`: a published page's id assigns it, `0` unsets the slot, `"create"` makes a published page
  with FluentCart's own title and content. Slots: `shop`, `cart`, `checkout`, `receipt`, `account`,
  and `order_review` where FluentCart has it.

### Shipping

"Free delivery to Malaysia and Singapore, RM40 to Thailand, RM200 everywhere else" is three zones:

```json
{ "name": "Malaysia & Singapore", "region": "countries", "countries": ["MY", "SG"],
  "methods": [ { "title": "Free delivery", "type": "free_shipping", "description": "3-5 working days" } ] }
{ "name": "Thailand", "region": "countries", "countries": ["TH"],
  "methods": [ { "title": "Standard", "type": "flat_rate", "rate": "per_order", "amount": "40" } ] }
{ "name": "Everywhere else", "region": "all_except", "countries": ["MY", "SG", "TH"],
  "methods": [ { "title": "International", "type": "flat_rate", "rate": "per_order", "amount": "200" } ] }
```

- **Checkout offers every zone that matches an address, together, the dearer method first.** Zone
  order doesn't matter. So "everywhere else" is an `all_except` zone, never a Whole World (`all`) zone
  beside country zones. The result's `notes` name every overlap; fix them.
- `methods`, when sent, **replaces** the zone's list: name a method by `id` to keep and change it,
  leave one out to delete it, omit `methods` to keep them all. An update keeps any key you don't send.
- `rate`: `per_order`, `per_item`, `per_price` (`amount` is a percentage), `per_weight` (needs
  `weight_tiers`). `free_shipping` always charges 0 (there's no "free over X" in FluentCart's core).
- A **shipping class** (`write-fluent-cart-shipping-class`) adds its `cost` (fixed or a percentage,
  per item or once) to whatever method is chosen; give a product its class with
  `write-fluent-product` `shipping_class`.
- `delete: true` with an `id` deletes a zone with its methods, or a class with its own zones.
- **(v1.107.0)** A method's `states` are FluentCart's state codes for the zone's country, in any case:
  CanAI stores FluentCart's own spelling (US `CA`, Morocco `maagd`), which checkout matches exactly,
  and refuses a code FluentCart doesn't list.

### Products

An attribute product, the "book + coffee" case:

```json
{ "title": "Building Your Digital Net Worth", "status": "publish", "images": [19],
  "categories": ["books"], "shipping_class": 1,
  "attributes": [
    { "group": "Units", "terms": ["1 autographed book", "2 autographed books"] },
    { "group": "Coffee for Jan", "terms": ["With coffee for Jan", "Without coffee"] } ],
  "variations": [
    { "attributes": { "Units": "1 autographed book", "Coffee for Jan": "With coffee for Jan" }, "price": "160" },
    { "attributes": { "Units": "1 autographed book", "Coffee for Jan": "Without coffee" }, "price": "150" },
    { "attributes": { "Units": "2 autographed books", "Coffee for Jan": "With coffee for Jan" }, "price": "295" },
    { "attributes": { "Units": "2 autographed books", "Coffee for Jan": "Without coffee" }, "price": "285" } ] }
```

- **Groups and terms** are named by id, slug or title (any case); a number is an id when one
  exists, else a title (`"1"` can be a term). A title FluentCart's library doesn't have creates that
  group or term (FluentCart's `products/create` permission) as plain buttons; colours, images and a
  dropdown picker are `write-fluent-attribute-group`'s (see **Attribute library**). FluentCart
  generates one variation per combination; a variation entry names its combination with
  `attributes: {group: term}`, one term per group.
- **A new combination left at 0 without a price in the call is set inactive** and listed in
  `warnings`, so nothing goes on sale for free by accident. **(v1.107.0)** It carries the dearest
  combination's price as a placeholder (so does one the call sends with only `"status": "inactive"`), since FluentCart's "From …" price and price sort count
  inactive variations too; give it its own price when you switch it on. Send `"price": "0.00"` to
  sell one free.
- **Simple and simple_variations:** `variations` is the list on a create (each with a `price`;
  one makes `simple`). On an update it's a list of changes: name a variation by `id` (an attribute
  product's also by `attributes`); an entry with neither adds a variation (simple_variations only).
- **Taking things off sale:** `"status": "inactive"` on a variation, `"status": "draft"` on a
  product. Both keep order history.
- **(v1.107.0) Deleting:** `{ "id": 950, "delete": true }` deletes a product through FluentCart, and
  `{ "id": 950, "variations": [{ "id": 31, "delete": true }] }` a variation of a `simple_variations`
  product (never the last one; an attribute product's combinations follow its `attributes`). Either
  is refused while **any** order includes it: take it off sale instead. A product's images stay in
  the media library. FluentCart's `products/delete` permission applies. When the default variation
  goes, the first remaining one becomes the default.
- **(v1.107.0) Stock:** `"manage_stock": true` tracks stock (it needs FluentCart's Stock Management
  module, FluentCart → Settings → Modules; ask the owner), `false` stops. Each variation's `stock` is
  its units available; a tracked variation without stock shows as out of stock, and `warnings` names
  each one. `get-fluent-products` returns `manage_stock` and each variation's `stock` (`null` while
  untracked).
- **(v1.107.0) Subscriptions:** a new variation (simple or simple_variations) may be one:
  `"payment": { "type": "subscription", "interval": "monthly", "times": 12, "trial_days": 7,
  "signup_fee": "10", "signup_fee_name": "Starter kit" }` (`interval`: daily, weekly, monthly,
  quarterly, half_yearly, yearly; `times` 0 bills until the customer cancels; `trial_days` up to
  365; a signup fee needs its name). An existing subscription's terms change the same way
  (`signup_fee: null` drops the fee). A variation never switches between one-time and subscription:
  add a new one and set the old one inactive. Attribute combinations are one-time. Checkout needs a
  payment method that takes subscriptions (Cash on Delivery doesn't).
- **Type changes** follow FluentCart: simple → simple_variations (`type`), anything →
  advanced_variations (`attributes` required; FluentCart replaces the variations, and the result
  says how many went), never back. Sending back the attribute set `get-fluent-products` returned
  changes nothing. Changing an attribute product's `attributes` regenerates its
  combinations: surviving ones keep their price and SKU, the rest are deleted (as FluentCart's
  editor does).
- A new product is a **draft** unless `status` says otherwise. Images are attachment ids (sideload
  URLs first with `wpcanai-sideload-url`); `images` replaces the gallery, the first is featured.
  `categories` / `brands` take existing terms' ids or slugs and replace the product's.
- SKUs: at most 30 characters, unique across the store. Variation titles: at most 192.
  `compare_price` is the "was" price, at least the price; `null` removes it, and raising the price
  past it drops it (as FluentCart's bulk edit does).
- **The requested status comes last:** a new product stays a draft until every other part is
  written, and a scheduled product keeps its date.
- **If FluentCart fails partway**, the error carries `product_id`: read the product with
  `get-fluent-products`, then send only what's missing with that `id`, naming variations by id.
  Never repeat the create: that makes a duplicate.
- `write-fluent-product` is annotated destructive: changing `attributes` or switching to
  advanced_variations lets FluentCart delete variations.

### Attribute library (v1.107.0)

`wpcanai-write-fluent-attribute-group` writes FluentCart's attribute groups and their terms, in the
shape `get-fluent-cart-store` → `attributes` lists (`{id, slug, title, type, styling, terms: [{id,
slug, title, color, image}]}`):

```json
{ "title": "Glaze", "type": "color", "styling": "dropdown",
  "terms": [ { "title": "Celadon", "color": "#ace1af" }, { "title": "Tenmoku", "color": "#3b2416" } ] }
{ "id": 17, "terms": [ { "id": 80, "title": "Celadon Green" }, { "title": "Ash", "color": "#bbbbbb" }, { "id": 81, "delete": true } ] }
```

- `type`: `options` (buttons with the term names), `color` (dots) or `image` (pictures); `styling`:
  `buttons` or `dropdown`, the product page's picker. A `color` group's terms each need a `color`
  (`#rgb` / `#rrggbb`), an `image` group's an `image` (an attachment id, or the URL the read gave).
- `terms` is a list of changes: no `id` creates a term, `id` updates its title, colour or image,
  `{id, delete: true}` deletes it; terms you leave out stay. Slugs are kept once made.
- Deleting a group (`{id, delete: true}`) or a term that products' variations use is refused, as
  FluentCart refuses it. Put a group's terms on a product with `write-fluent-product` `attributes`.

Then design the pages: a template reads the same product through `post.fct` (see **Attribute
products** and **Direct checkout, no cart**).

## Template types

| Type | Claims the request | Delegate page | Context |
|---|---|---|---|
| `single-fluent-products` | a product (`/item/{slug}/`), when a published template of this type exists | none: `post` is the product | `post` with `post.fct`, `post.featured_image`, `post.author` |
| `fct-product-category` | a product category or brand archive (any public taxonomy on `fluent-products`), by the rule below | the shop page | `products`, `pagination`, `term`, `current_term`, `current_category` |
| `fct-shop` | the page FluentCart's `shop_page_id` names | the shop page | `products`, `pagination` |
| `fct-cart` | `cart_page_id` | the cart page | `post` = the page |
| `fct-checkout` | `checkout_page_id` | the checkout page | `post` = the page |
| `fct-receipt` | `receipt_page_id` | the receipt page | `post` = the page |
| `fct-account` | `customer_profile_page_id`, every portal sub-path included | the account page | `post` = the page |
| `fct-order-review` | `order_review_page_id` (2.x with reviews; offered once its page is set) | the order-review page | `post` = the page |

- **Page types follow FluentCart's page settings** (FluentCart → Settings → Store Settings →
  Pages Setup), not slugs: a fresh FluentCart beside WooCommerce often has `/cart-2/`,
  `/checkout-2/`, `/shop-2/`. Read the ids with `wpcanai-get-fluent-cart-pages`.
- **WooCommerce wins** a page configured as both stores' page. The types are `fct-` prefixed so a
  site running both keeps them apart; never put WooCommerce's `cart` / `checkout` / `shop` types or
  `wc_*` / `cart.*` Twig on FluentCart pages.
- **The archive rule.** A product term archive resolves to `fct-product-category` when a template
  of that type exists, or when no `archive` template does. A site whose generic `archive` template
  draws these archives keeps it until a `fct-product-category` template is created.
- **Page types are not existence-gated** (like WooCommerce's): without a template the page is its
  own delegate, so it renders as before. `single-fluent-products` is existence-gated (the typed
  single rule).
- **A product can carry its own `_canai_html`**, written with `wpcanai-write-meta` on the product's
  post id; FluentCart's product editor has no CanAI box. Prefer one `single-fluent-products`
  template for the whole catalogue.
- **A type template needs its own layout.** None of these types is a layout, so a template of
  one draws the whole page, and `wpcanai_default_layout` doesn't wrap it. It sits inside a layout
  only when its own `_canai_layout` names a `layout` template: pass `layout` (the layout's post id)
  to `wpcanai-create-template`, or `wpcanai-write-meta { "post_id": <template>, "layout": <id> }`
  on an existing one. The default layout applies only where no template of the type exists (the
  last column below).

### What renders where

| Request | Type template exists | No template, delegate has `_canai_html` | Neither, a layout applies |
|---|---|---|---|
| Product | the template, `post` = the product | the product's own `_canai_html` | FluentCart's product page in the layout: `fct_product_page()`, then the description's `the_content` (reviews on 2.x), then `[fluent_cart_related_products]` |
| Term archive | the template | the shop page's Twig, with the term-scoped context | FluentCart's archive body in the layout: title, term description, the term's shop app |
| Shop, cart, checkout, receipt, account, order review | the template, `post` = the page | the page's Twig | the page's `the_content` (its shortcode or block) |

`wpcanai-resolve-content-id` reports the same shapes for these types (`template-rendered`,
`page-rendered`, …); edit its `content_post_id`.

## Twig functions

Every HTML function returns safe Markup: print it with `{{ }}`, no `|raw`.

| Call | Prints / returns |
|---|---|
| `fct_product_page(product?, {add_to_cart, buy_now, quantity})` | FluentCart's product summary: gallery, title, meta, excerpt, prices, buy section |
| `fct_buy_section(product?, {add_to_cart_text, buy_now_text, icon_only, add_to_cart, buy_now, quantity})` | variation picker, quantity, Add to Cart and Buy Now |
| `fct_product_gallery(product?, {thumb_position, max_thumbnails})` | the gallery; `thumb_position`: `bottom`, `top`, `left`, `right` |
| `fct_product_price(product?)` | price or range, compare price, suffix, in the visitor's currency |
| `fct_add_to_cart_button(variation?, {text, class})` | FluentCart's Add to Cart button |
| `fct_buy_now_button(variation?, {text, class})` | FluentCart's Buy Now (instant checkout) button |
| `fct_product_card(product?, {price_format, add_to_cart, buy_now})` | FluentCart's product card; `price_format`: `starts_from` (default) or `range` |
| `fct_shop_app(attrs)` | `[fluent_cart_products]`: the live shop with filters, sorting and AJAX paging |
| `fct_mini_cart(attrs)` | `[fluent_cart_mini_cart]` |
| `fct_cart_page(attrs)` / `fct_checkout_page(attrs)` / `fct_receipt_page(attrs)` / `fct_account_page(attrs)` | `[fluent_cart_cart]` / `[fluent_cart_checkout]` / `[fluent_cart_receipt]` / `[fluent_cart_customer_profile]` |
| `fct_product(product?)` | data: the single `post.fct` array; empty for a non-product |
| `fct_get_products({per_page, sort_by, sort_type, category, brand, on_sale, product_type, include_ids, exclude_ids, include_slugs, exclude_slugs})` | data: published products as posts, each with the loop `post.fct` and `featured_image` |
| `fct_cart()` | data: the read-only cart summary (below) |
| `fct_price(cents)` | text: an amount in the store's money format |
| `fct_buy_now_url(variation?, quantity = 1)` | text: the variation's instant-checkout URL; `''` when there's no such variation |
| `fct_url(key)` | text: the `shop`, `cart`, `checkout`, `receipt` or `account` page's URL in the current language (localized like `turl()`); `''` while the page isn't set |
| `fct_shipping_zones()` | data: the shipping zones checkout can offer, with countries and methods (see **Shipping in templates**) |
| `fct_shipping_rates(country, variation?, state?)` | data: what checkout would charge to ship one unit to a country (or one of its states), cheapest first (see **Shipping in templates**) |

### Arguments

- **`product`** is a post id, a **slug** (`'building-your-digital-net-worth'`, any non-numeric
  string), a `WP_Post`, a `post.fct` / `fct_product()` array, or omitted. A slug names one product
  (a published one wins over a draft namesake); a slug no product has, or one that is ambiguous,
  renders nothing and `fct_product()` returns `[]`. Templates that shouldn't carry ids use slugs.
  Omitted means the `post` being rendered when it is a product, else the global post when that is
  one. Inside a loop, name the loop variable `post` — `{% for post in products %}` — and the
  omitted argument is that iteration's product; with another name, pass it (`fct_product_card(p)`).
  A number in a product function is always a post id.
- **`variation`** (the two buttons and `fct_buy_now_url()`) is an entry of `post.fct.variations`,
  a product (a `WP_Post` or a `post.fct` array: its default variation), or a bare number.
- **The variation-id-first rule.** A bare number in a variation argument is read as a **variation
  id first**, the way FluentCart's own button shortcodes read it, and only when no variation has
  that id as a product id. Variation ids and product post ids overlap on real stores, so a bare
  product id can buy the wrong item. Use the unambiguous forms:

  ```twig
  {{ fct_add_to_cart_button(post) }}                          {# the product's default variation #}
  {{ fct_add_to_cart_button(post.fct.default_variation_id) }} {# a variation id: also safe #}
  {% for variation in post.fct.variations %}
    {{ fct_buy_now_button(variation, {text: variation.title}) }}
  {% endfor %}
  {% set p = fct_product(42) %}{{ fct_add_to_cart_button(p) }} {# product 42, never variation 42 #}
  ```
- **Options in the product's place.** An options hash may stand where the product goes:
  `{{ fct_buy_section({buy_now_text: 'Buy now'}) }}`. Empty options keep FluentCart's labels.
- **Render switches** (`add_to_cart`, `buy_now`, `quantity`) on `fct_buy_section()`,
  `fct_product_page()` and (no `quantity`) `fct_product_card()`: set one to `false` to leave that
  part out of **this render only** (FluentCart's `RenderGate`, 1.6.6 and 2.x). They only hide:
  `true` or no key leaves FluentCart's own decision (catalog mode, stock, subscriptions). See
  **Direct checkout, no cart**.
- **`class`** on a button replaces FluentCart's classes; CanAI keeps `fct-loader` on Add to Cart,
  which keeps its spinner hidden until a click.
- **Shortcode attributes** (`fct_shop_app`, `fct_mini_cart`, the page functions) are FluentCart's
  own and pass through:
  - **Scalars** go into the shortcode text, `true` as `yes` and `false` as `''`, each
    `esc_attr()`-escaped, so `&`, quotes and brackets reach FluentCart entity-encoded.
  - **A hash or a list goes through only where FluentCart reads one.** `fct_shop_app()`:
    `custom_filters` (the filter sidebar: `taxonomies`, `price_range`, `live_filter`, `enabled`),
    `default_filters` (preset terms per taxonomy, plus `wildcard`, `sort_by` and
    `allow_out_of_stock`; applied only with `enabled: true`), `filters` (only with
    `enable_filter: true`) and `colors` (read, but nothing is drawn from it). On 2.x,
    `fct_checkout_page()` also takes `variation_ids`, `variant_ids` and `variation_id`: they ask for
    a custom-product checkout that an add-on draws, and without one the checkout is empty.
  - **Anywhere else a hash or a list is dropped.** `ids`, `exclude_ids`, `category_id` and
    `taxonomies` take comma strings: `'937,938'`, `'product-brands:4,5'`.
  - **A hash goes as plain data**, values as written (a Twig Markup becomes its text). CanAI drops
    the parts FluentCart can't read, which would throw for every visitor: a
    `custom_filters.taxonomies` entry that is neither a taxonomy name nor a hash of taxonomy →
    `{label, options: [{term_id, name, parent}]}`, a `default_filters.tax_query` that isn't a hash,
    and a `filters.sort_by` that isn't a scalar.
  - **Term scoping** on a `fct-product-category` render: see **Two shop styles**.
- **`include_slugs` / `exclude_slugs`** (a list or a comma string) name published products by
  slug, merged with `include_ids` / `exclude_ids`. `include_slugs` that name no product list
  nothing; they never widen the list. Order follows `sort_by`, not the list.
- **`fct_get_products()`** takes only the keys above. `per_page` defaults to Settings → Reading,
  at most 100, one page (no pagination). `sort_by`: `id`, `date`, `title`, `price`; `sort_type`:
  `ASC` / `DESC`. `category` / `brand`: term ids or slugs, a list or a comma string; a value that
  names no term matches nothing. `product_type` is FluentCart's (`physical`, `digital`,
  `subscription`, `onetime`, `simple`, `variations`).

## `post.fct`

On a product page `post.fct` is the single shape. Each post of `products` and
`fct_get_products()` carries the loop shape; `fct_product()` returns the single shape for any
product.

```
post.fct = {
  id, type,              # 'simple' | 'simple_variations' | 'advanced_variations'
  fulfillment,           # FluentCart's fulfillment type
  url,
  price: { min, max, min_formatted, max_formatted, is_range,
           compare, compare_formatted, on_sale },
  in_stock, stock_status,
  has_subscription, sold_individually,
  default_variation_id, buy_now_url,
  can_add_to_cart,
  images: [ { id, url, alt } ],
  categories: [ { id, name, slug, url } ], brands: [ … ],
  attributes: [ { id, slug, title, type,          # advanced_variations only, else []
                  terms: [ { id, slug, title, color, image } ] } ],
  variations: [ { id, title, sku, price, price_formatted, compare_price, compare_price_formatted,
                  on_sale, in_stock, available, payment_type, subscription_terms, image, buy_now_url,
                  attributes: [ { group: { id, slug, title }, term: { id, slug, title } } ] } ],
}
```

- **Money** is integer cents plus a `_formatted` **text** (it autoescapes; never `|raw`). Under 2.x
  multi-currency the cents are in the store's base currency and `_formatted` is in the visitor's.
  `fct_price(cents)` formats the same way.
- **Prices** come from the active variations. `price.compare` is the default variation's compare
  price, set only for a single price it exceeds; `price.on_sale` is true when any variation is on
  sale. An absent amount is `null`.
- **Variations** are the active ones only, in FluentCart's order. `available` is the stock count
  while FluentCart tracks one, else `null`. `image` is the variation's own image or `null`.
- **Stock.** `in_stock` follows FluentCart's availability; while its stock-management module is off
  every product is in stock. `stock_status` is the class FluentCart's stock badge uses:
  `in-stock`, `out-of-stock`, or whatever a `fluent_cart/product_stock_availability` filter makes
  it (`low-stock`), so don't test it against two values only.
- **`can_add_to_cart`** is true for a `simple`, one-time, in-stock product: what FluentCart's card
  offers a button for, and **(v1.107.0)** false while the store's checkout mode is a Buy Now one
  (see **Direct checkout, no cart**). It ignores catalog mode (`RenderGate`); FluentCart's buttons
  still apply it.
- **Images** are the gallery, the featured image first. `alt` falls back to the media title
  FluentCart stores. An image outside the media library has `id: 0`. Use `post.fct.images[0]` for
  the product picture; `post.featured_image` covers media-library images only.
- **Attributes** (`advanced_variations`, v1.105.0) are the product's attribute groups and their
  terms **in the product's own order** (FluentCart's `attribute_config`, what its editor shows), every
  configured term listed, as FluentCart's selector lists them. `type` is the group's display type
  (`options`, `color`, `image`); a term's `color` is a CSS colour safe for a `style` attribute (or
  `''`), `image` a URL (or `''`). Each variation's `attributes` are its group/term pairs in the
  same group order. `variations` holds the **active** ones only, so a combination of terms may have
  no variation: treat that as unavailable. Other product types have `[]` in both places. A whole
  shop grid of attribute products costs three queries.
- **The loop shape** drops `variations[].subscription_terms` and every image but the first; it keeps
  `attributes`.
- **Title and text are not in it.** Print them from `post` (rule 1).

## Shop and archive context

On `fct-shop`, `fct-product-category`, and the shop page's own Twig when it renders an archive:

```twig
products               {# posts: the loop post.fct + featured_image #}
pagination.current_page
pagination.total_pages
pagination.total
pagination.per_page
term / current_term / current_category   {# archives only: the queried category or brand #}
```

- The query is FluentCart's own main-query listing: scoped to the queried term **and its child
  terms**, this request's page, `per_page` from Settings → Reading capped at 100. It leaves out
  products FluentCart marks out of stock.
- `{{ wpcanai_pagination() }}` prints `<nav class="fct-pagination" aria-label="Product pagination">`
  around `paginate_links()` (a `<ul class="page-numbers">`), linking `…/page/2/`. Empty for a single
  page.
- The cart is not in the context. Call `fct_cart()` where you need it.

## Two shop styles

**A Twig grid over `products`** — full design control, full-page pagination, no live filters:

```twig
{# Section / Products #}
<section class="grid grid-cols-2 gap-6 md:grid-cols-4">
  {% for post in products %}
    {# Card / Product #}
    <article>
      <a href="{{ turl(post.fct.url) }}">
        {% if post.fct.images %}<img src="{{ post.fct.images[0].url }}" alt="{{ post.fct.images[0].alt }}" loading="lazy">{% endif %}
        <h2>{{ post.post_title }}</h2>
      </a>
      <p>{{ post.fct.price.is_range ? post.fct.price.min_formatted ~ ' – ' ~ post.fct.price.max_formatted : post.fct.price.min_formatted }}</p>
      {% if post.fct.can_add_to_cart %}{{ fct_add_to_cart_button(post) }}{% else %}<a href="{{ turl(post.fct.url) }}">{{ t('View options') }}</a>{% endif %}
    </article>
  {% endfor %}
</section>
{{ wpcanai_pagination() }}
```

**FluentCart's live shop** — `{{ fct_shop_app({per_page: 12}) }}`: filters, sorting and AJAX paging
in FluentCart's own cards (CanAI cards inside it are not supported yet).

- **The filter sidebar** is `custom_filters`, drawn the same on 1.6.6 and 2.2.0:
  `{{ fct_shop_app({custom_filters: {price_range: true, taxonomies: ['product-brands']}}) }}`.
  `live_filter: false` in it adds an Apply button; `search: true` draws nothing. (`enable_filter`
  with `filters` is not the sidebar and draws none.)
- **Term scoping.** On a `fct-product-category` render the shop app stays on the queried term and
  its children unless the attributes choose terms. They choose terms when `taxonomies`, `category`
  or `category_id` is a scalar (a hash or a list there is dropped and doesn't count), or when
  `default_filters` has `enabled: true` and terms of the archive's own taxonomy (FluentCart adds
  the archive's terms to those, so scoping too would widen the list). Terms of another taxonomy in
  `default_filters` keep the scope and narrow within the archive's term. The scope CanAI adds:
  - 2.x: `taxonomies="<taxonomy>:<ids>"`;
  - 1.6.6 category: `category_id="<ids>"`;
  - 1.6.6 brand (or any other taxonomy): `ids` of the term's **newest 100** published products,
    the most 1.6.6's AJAX paging forwards.
- **A sidebar keeps the scope.** A sidebar filter of another taxonomy narrows within the archive's
  term; one of the archive's own taxonomy adds the shopper's picks to the archive's terms rather
  than narrowing them.

On a term archive drawn by a generic `archive` template (the archive rule), `fct_shop_app()` is not
term-scoped: create a `fct-product-category` template.

## Product template

```twig
{# Container / Product #}
<main class="mx-auto grid max-w-6xl gap-10 md:grid-cols-2">
  {{ fct_product_gallery({thumb_position: 'left'}) }}
  <div>
    <h1>{{ post.post_title }}</h1>
    {% for c in post.fct.categories %}<a href="{{ turl(c.url) }}">{{ c.name }}</a>{% endfor %}
    {{ fct_product_price() }}
    {{ fct_buy_section() }}
    {{ the_content(post.post_content) }}   {# the description; FluentCart's reviews follow it #}
  </div>
</main>
```

Or `{{ fct_product_page() }}` for FluentCart's whole summary in one call. Fully custom buttons:
`<button data-fluent-cart-add-to-cart-button data-cart-id="{{ v.id }}" data-quantity="1">` works
(FluentCart's listener is delegated on `document`), but it skips catalog mode and the stock and
subscription checks; prefer the helpers and use it only when the design can't take FluentCart's
button markup. A Buy Now link needs no JavaScript: `<a href="{{ fct_buy_now_url(v, 2) }}">`.

- **Give the template its layout** (`layout` in `wpcanai-create-template`): the default layout
  doesn't wrap a type template (see **Template types**).
- **Keep the description inside a lone `<article>`.** When the template has exactly one
  `<article>` (inside its `<main>`, if it has one), the product's Markdown is that article alone
  (`HtmlToMarkdown::content_root()`): an `<article>` around the summary with the description in a
  sibling `<section>` loses the description in Markdown. Put `the_content()` inside the article, or
  use no `<article>`.

### Attribute products (v1.105.0)

`fct_buy_section()` draws FluentCart's own attribute selectors (one control per group, wired to its
buttons). FluentCart's selectors work only inside its buy section, so there is no "selectors only"
helper. For your own controls, build a picker from `post.fct.attributes` and link the chosen
combination's `buy_now_url` (instant checkout, no cart):

```twig
{% set p = post.fct %}
<div x-data="{ pick: {}, variations: {{ p.variations|json_encode|e('html_attr') }},
     get match() { return this.variations.find(v => v.attributes.every(a => this.pick[a.group.id] === a.term.id)) } }">
  {% for group in p.attributes %}
    <fieldset><legend>{{ group.title }}</legend>
      {% for term in group.terms %}
        <label><input type="radio" name="g{{ group.id }}" @change="pick[{{ group.id }}] = {{ term.id }}"> {{ term.title }}</label>
      {% endfor %}
    </fieldset>
  {% endfor %}
  <a :href="match ? match.buy_now_url : null" :aria-disabled="!match"
     x-text="match ? match.price_formatted : '{{ t('Choose an option') }}'"></a>
</div>
```

It needs Alpine loaded (CanAI → Settings, the owner's Alpine.js switch; see SKILL.md → **Bundled
libraries**). A partial
choice, or a combination with no active variation, leaves the link without an `href`. The link
skips FluentCart's stock check, as any hand-built Buy Now link does.

## Direct checkout, no cart (v1.105.0)

For a store that sells by instant checkout only:

- **(v1.107.0) The store-wide checkout mode** does it everywhere at once: the setting
  `wpcanai_fct_checkout_mode` (CanAI → Settings → FluentCart checkout, or `wpcanai-update-settings`)
  is `cart` (the default), `buy_now` (no Add to Cart button anywhere) or `buy_now_one` (no Add to
  Cart and no quantity field). It reaches every FluentCart surface — product pages, buy sections,
  standalone buttons, cards and `fct_shop_app()`'s own requests — and `post.fct.can_add_to_cart` is
  false. FluentCart's own card of a simple one-time product loses its button (it has no Buy Now there; in a CanAI card print `fct_buy_now_button(post)`); "View Options" stays. Changing the mode purges
  the page cache. Prefer it to the per-render switches below for a whole store. It hides buttons; a hand-built
  `data-fluent-cart-add-to-cart-button` still adds to a cart.

- **Product pages:** `{{ fct_buy_section({add_to_cart: false}) }}`, plus `quantity: false` to drop the
  quantity box. FluentCart's attribute picker still drives the Buy Now link. The same switches work
  on `fct_product_page()`; `fct_product_card(post, {add_to_cart: false})` for cards.
- **Grids:** a Twig grid over `products` with `fct_buy_now_button(post)` or a
  `fct_buy_now_url(post)` link; FluentCart's live shop (`fct_shop_app()`) redraws its cards in its own
  requests, where the per-render switches can't reach (the checkout mode does).
- **The floating cart button** is FluentCart's store setting **Show cart icon in body**
  (`show_cart_icon_in_body`); its "nav" icon setting is read nowhere. There's no header cart to
  remove unless the layout prints `fct_mini_cart()`.
- `wpcanai-scan` accepts a buy-now-only product page: `fct_buy_section()` and `fct_buy_now_url()`
  both count as a way to buy. In a Buy Now checkout mode, `fct_add_to_cart_button()` and
  `[fluent_cart_add_to_cart_button]` no longer count (`fct_product_no_buy` says so).

## Shipping in templates (v1.105.0)

Print delivery copy from FluentCart's real zones instead of hardcoding it, so it never drifts.

```twig
{% set th = fct_shipping_rates('TH') %}            {# one unit of the product being rendered #}
{% if th.methods %}{{ t('Delivery to Thailand from {price}.', {price: th.methods[0].amount_formatted}) }}{% endif %}
{% set ca = fct_shipping_rates('US', null, 'CA') %} {# a state, for methods limited to states #}

{% for zone in fct_shipping_zones()|filter(z => z.methods|filter(m => m.rate == 'free')|length) %}
  <p>{{ t('Free delivery to {places}.', {places: zone.countries|map(c => c.name)|join(', ')}) }}</p>
{% endfor %}
```

- **`fct_shipping_zones()`**: `[{ id, name, region, countries: [{code, name}], methods: [{ id, title,
  description, type, rate, amount, amount_formatted, percent, states }] }]`, in FluentCart's admin
  order. `region` is `all` (Whole World), `countries` or `all_except`. Only what checkout can offer:
  enabled methods of zones with no shipping class. `rate` is how FluentCart charges: `free`,
  `per_order`, `per_item`, `per_price` (`percent` of the goods) or `per_weight` (tiers). `amount`
  (cents) and `amount_formatted` are set for `per_order` / `per_item`, else `null`. `states: []` is
  every state.
- **`fct_shipping_rates(country, variation?, state?)`**: `{ country, country_name, state, status,
  methods: [{ id, title, description, type, zone: {id, name}, amount, amount_formatted, is_free }] }`
  — FluentCart's own charge to ship **one unit** of the variation (default: the rendered product's
  default variation; a product, slug or `variations` entry also works; `null` to name a state
  without one) to an address in `country` (ISO2), **cheapest first**. **(v1.107.0)** `state` (its
  code in any case, matched to FluentCart's own) offers the methods limited to that state. Class surcharges,
  weight tiers and free-shipping products count. `status`: `ok`, `no_methods`, `needs_state` (only
  state-restricted methods, and no state given), `no_shipping_needed` (digital, or the product ships
  free), `unknown_country`, `no_product`. It never reads or creates a cart.
- **Every matching zone is offered together.** A Thailand zone at RM40 and a Whole World zone at
  RM200 both show for Thailand, the dearer first. For "RM40 for Thailand, RM200 elsewhere" the second
  zone must be **all countries except Thailand** (FluentCart's "Selection" region, excluded), not
  Whole World. Zone order doesn't matter at checkout.
- "Free shipping over X" is a FluentCart Pro pricing rule; these helpers don't see it.

## The cart badge

- **FluentCart's own:** `{{ fct_mini_cart() }}` — a button that opens the cart drawer, the count and
  the total. It prints the count **only once the cart has items** (FluentCart's default
  `show_item_count: 'has_items'`): at 0 there is no count. `{show_item_count: 'always'}` shows 0
  too, `'never'` hides it.
  `{count_mode: 'total_quantity'}` counts units instead of products.
- **Your markup:** a badge inside a button FluentCart knows:

  ```twig
  <button type="button" data-fluent-cart-cart-expand-button aria-label="{{ t('Open cart') }}">
    <i data-lucide="shopping-bag"></i>
    <span data-cart-badge-count>{{ fct_cart().count }}</span>
  </button>
  ```

  `[data-fluent-cart-cart-expand-button]` opens the drawer; FluentCart's script rewrites every
  `[data-cart-badge-count]` after each cart change. For units, add
  `data-cart-count-mode="total_quantity"` and print `fct_cart().quantity`. A total:
  `<span data-fluent-cart-cart-total-price>{{ fct_cart().total_formatted }}</span>`.
- **`fct_cart()`** returns `{ count, quantity, is_empty, total_formatted, items: [ { variation_id,
  product_id, title, variation_title, quantity, image, url, total_formatted } ] }`. `count` is the
  distinct items, `quantity` the units; amounts print as FluentCart's cart drawer prints them. It
  reads the cart **without creating one** (no cart row, no cookie), once per request, and is empty
  during an instant checkout.
- **Cached pages show the cached count.** FluentCart's script seeds the badge from the
  server-printed values and doesn't fetch the cart on load, so a page served from a page cache
  shows the cached count until the visitor's next cart change. Don't promise a live badge there.

## Store pages

```twig
{# Container / Checkout #}
<main class="mx-auto max-w-5xl">
  <h1>{{ post.post_title }}</h1>
  {{ fct_checkout_page() }}
</main>
```

- `{{ the_content(post.post_content) }}` instead of the helper prints the page's own shortcode or
  block (`[fluent_cart_checkout]`, `<!-- wp:fluent-cart/customer-profile /-->`, …), and the scan
  accepts it.
- The page functions need no attributes. On 2.x `fct_checkout_page()` reads a variation list, but
  only for an add-on's custom-product checkout (see **Shortcode attributes**).
- Give a store page's type template its layout too (`layout`): the default layout doesn't wrap it.
- The account template covers every portal sub-path (`/account/purchase-history`, …, and 2.x's
  "My Reviews" tab).
- **Order review (2.x).** The page must be set in Pages Setup before `fct-order-review` applies.
  Its `[fluent_cart_order_review]` shortcode prints no `<h1>`, so the template prints the title:
  `<h1>{{ post.post_title }}</h1>` then `{{ the_content(post.post_content) }}` (there is no
  `fct_*` helper for it). It shows an order to anyone holding the order's `order_hash` (FluentCart's
  design), and FluentCart doesn't hide the cart drawer there.
- When CanAI renders the cart, checkout, receipt, account or order-review page it sends
  `DONOTCACHEPAGE` and `nocache_headers()`. CanAI never answers them in Markdown and never gives
  them a preview link (`not_previewable`). On a site that also runs the ToSAI plugin, ToSAI may
  still answer them in Markdown, since CanAI doesn't claim them.
- FluentCart's `?fluent-cart=…` routes (instant checkout, modal checkout, downloads, print slips)
  render before CanAI and keep FluentCart's own output.

## Assets and styles

- Each helper loads FluentCart's asset set for what it draws: the product helpers and both buttons
  the single-product set (with the advanced-variation action), `fct_shop_app` the archive set,
  `fct_mini_cart` the mini-cart set; the card and the shortcodes load their own. FluentCart also
  loads assets by itself on products, term archives and the store pages.
- **Head preload.** On a request CanAI renders, CanAI reads the render post's `_canai_html` (unless
  a non-layout type template replaces it), its layout chain, and templates named by a **literal**
  `wpcanai_template('name')` in those, **one level deep**, Twig comments ignored. It loads the sets
  of the `fct_*` helpers it finds in `<head>`. It never loads the checkout set. A helper it can't
  see (a name built at render time, a nested include) still works; its styles print late, after
  `wp_head()`. `fct_product_card()` isn't preloaded: cards in a layout print their styles late.
  Keep a header mini cart in the layout or in a template the layout includes by literal name.
- **The cart drawer's stylesheet** (`CartLoader::enqueueStyle()` only, no script, no cart read) is
  queued in `<head>` on a request CanAI renders whenever the drawer may print
  (`Bridge::cart_drawer_may_print()`): a cart cookie or a signed-in visitor, then FluentCart's own
  checks (not in an iframe, global assets on, floating cart button on, not the checkout, the
  receipt or an instant checkout). FluentCart prints the drawer in `wp_footer` ahead of that
  stylesheet, on any theme, which otherwise dims the page grey on load while the cart has items. A
  password-locked page (core's password form) still gets it.
- **Stylesheet Removal can't remove FluentCart's styles**: handles starting `fluent-cart`,
  `fluent_cart`, `fluentcart` or `fct-`, and any style served from FluentCart's plugin folder, stay
  whatever the owner's list matches. Don't promise the owner they can dequeue them there.
- The layout must print `{{ wp_head() }}`, `{{ wp_footer() }}` and `<body class="{{ body_class() }}">`:
  FluentCart's scripts, cart drawer and colour settings depend on them.

## Languages

With CanAI's native translation on:

- `fct_url()` links carry the current language's prefix (`/ms/cart-2/`), like `turl()`.
- `post.fct.url` and the `categories` / `brands` `url`s are plain permalinks: print them through
  `turl()` (`{{ turl(post.fct.url) }}`).
- FluentCart's own URLs carry no prefix: the cart drawer's "Go to Checkout" and the checkout the
  Buy Now redirect lands on. Nothing in Twig changes them.
- **The customer portal is broken under a prefix.** On `/ms/account/…` FluentCart's Vue router
  rewrites the address to `/account/ms/account/…`, shows an empty pane, and its links drop `/ms/`.
  The unprefixed portal works. Tell the owner; don't try to fix it in Twig.

## FluentCart 2.2.0

- **The update migrates FluentCart's database** (`_fluent_cart_db_version` 1.0.52 → 1.0.57, a new
  `fct_product_reviews` table). FluentCart runs it itself; recommend a backup first.
- **The reviews module is on by default.** Reviews follow the description on a classic theme
  (`wpcanai-empty` is one), in the default body and under a template's `the_content()`. On a block
  theme FluentCart doesn't attach them to `after_product_content`, so a product shows none.
- **Order review** needs its page (see **Store pages**).
- **The portal** has a "My Reviews" tab; `fct-account` covers it.
- **A product's Markdown** ends with FluentCart's Product JSON-LD in its `## Structured data`
  section.
- **`fct_checkout_page()`** reads `variation_ids` / `variant_ids` / `variation_id` (see
  **Shortcode attributes**); 1.6.6's checkout reads no attribute.

## Known quirks and limits

- **FluentCart's price range counts inactive variations.** Its "From …" price and price sort take
  the lowest price of every variation. `write-fluent-product` gives a held-back combination a
  placeholder price (v1.107.0), but one set to 0 by hand in FluentCart's admin still reads 0.
  `post.fct.price` reads active variations only. Give every combination a price.
- **Store tools need their Guardrails area** (see **Store tools**); FluentCart's own admin and MCP
  server are unaffected by it.
- **Reviews** exist on 2.x only, and only on classic themes (see **FluentCart 2.2.0**).
- **1.6.6** has no reviews, no `order_review` page, no multi-currency.
- **The customer portal under a language prefix** (`/ms/account/…`) is broken (see **Languages**).
- **Store setup (FluentCart's rules).** A physical product needs a shipping zone before cash on
  delivery accepts an order. FluentCart's portal stays at "Confirm your email address" until the
  customer's email is verified. Tell the owner; neither is a CanAI setting.
- **`product_base`** in `get-fluent-cart-pages` ignores FluentCart's `with_front` permalink setting.
- **`fct-order-review`** is in `resolve-content-id`'s enum on every FluentCart version; while its
  page isn't set it answers "Nothing is authored for this type."
- **The admin bar** on a store page with its own `_canai_html` offers "Create Template (fct-cart)"
  rather than editing the page, and "Translate this page" is missing there (WooCommerce pages
  behave the same). Edit the page by its id.
- **Export/import:** a delegate to a page that is both stores' page exports only its WooCommerce
  ref; the skip warning for a row with no slug still names only WooCommerce.
- **FluentCart bugs CanAI works around** (both versions; nothing to do, but don't "fix" them in
  Twig):
  - the customer portal shortcode leaves an output buffer open for logged-out visitors; CanAI
    closes the buffers a render leaves, so it can't swallow the rest of the page;
  - ProductQuery's `on_sale` compares with the string `'compare_price'` and matches nothing; CanAI
    finds the on-sale products itself and passes them as `include_ids`;
  - ProductQuery matches `sort_type` in capitals only; CanAI sends `ASC` / `DESC`.
- **FluentCart bugs CanAI can't work around** (upstream):
  - `enable_filter` with a scalar `filters` that isn't JSON throws in FluentCart; pass `filters` as
    a hash;
  - a malformed `?filters[sort_by][]=…` query on FluentCart's shop page is a 500 for any visitor.
- **Each FluentCart renderer runs its own query**, so N buttons on a page cost N queries. That is
  FluentCart's cost; a grid of `fct_add_to_cart_button()` is fine at shop sizes.
