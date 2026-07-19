<?php
/**
 * Standalone Twig render harness for verify's Fix A (score templates, not
 * just pages). Renders ONE generated template/page's raw Twig source through
 * the plugin's OWN vendored twig/twig — the same library WPCanAI itself
 * renders with (src/Templating/TwigFactory.php) — against real,
 * sample-harvested data (src/sampleHarvest.mjs, on the Node side), so
 * verify.mjs can screenshot and pixel-diff the result instead of leaving
 * every template permanently unscored.
 *
 * Usage: php render-harness.php <context.json> <output.html>
 *   - Exit 0 + <output.html> written: render succeeded.
 *   - Exit 1 + a message on STDERR: render failed (Twig syntax/runtime
 *     error, or bad input) — the caller (twigRender.mjs) surfaces this
 *     verbatim in verify/report.md rather than silently scoring 0.
 *
 * Deliberate simplifications vs. the real plugin (documented, not hidden):
 *   - No SandboxExtension. The real plugin sandboxes every render (only an
 *     allowlisted set of functions/methods are callable) because it renders
 *     user-authored templates on a live, request-serving website. This
 *     harness only ever renders a canai-replicate run's OWN generated
 *     output, offline, for a human to eyeball a screenshot — sandboxing
 *     would only add "function not allowlisted" failures with no security
 *     benefit here.
 *   - get_menu()'s items come from the representative capture's real
 *     header/footer nav links (harvested on the Node side), not a live
 *     `wp_get_nav_menu_items()` query — there is no WordPress database to
 *     query. This is real, sample-derived nav data, not fabricated.
 *   - wpcanai_get_posts_enriched() returns whichever of `enrichedPost` /
 *     `relatedPosts` the call shape implies (see below) rather than
 *     re-deriving fields from the raw $args the way the real plugin's SQL
 *     query does — the Node side already computed the exact enriched
 *     values (sampleHarvest.mjs), so re-deriving them from $args here would
 *     just be redundant, not more correct.
 *   - Woo structural pages (shop/cart/checkout/my-account/order-received/
 *     product-category) are NOT attempted by the Node caller at all — this
 *     harness still registers safe no-op stubs for their Twig functions
 *     (wc_cart_totals(), wc_checkout_form(), ...) purely so a template that
 *     references one incidentally degrades to empty output instead of a
 *     hard "unknown function" failure, not because rendering those page
 *     kinds end-to-end is claimed to work.
 */

declare(strict_types=1);

[, $contextPath, $outputPath] = $argv + [null, null, null];

if (!$contextPath || !$outputPath) {
    fwrite(STDERR, "usage: php render-harness.php <context.json> <output.html>\n");
    exit(1);
}

try {
    $raw = file_get_contents($contextPath);
    if ($raw === false) {
        throw new RuntimeException("could not read context file: {$contextPath}");
    }
    $ctx = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);

    $vendorAutoload = $ctx['vendorAutoloadPath'] ?? (__DIR__ . '/../../../../vendor/autoload.php');
    if (!is_file($vendorAutoload)) {
        throw new RuntimeException("vendored Composer autoload.php not found at: {$vendorAutoload}");
    }
    require $vendorAutoload;

    $siteUrl = rtrim((string) ($ctx['siteUrl'] ?? 'https://example.com'), '/');
    $post = $ctx['context']['post'] ?? null;
    $posts = $ctx['context']['posts'] ?? null;
    $enrichedPost = $ctx['enrichedPost'] ?? null;
    $relatedPosts = $ctx['relatedPosts'] ?? [];
    $menus = $ctx['menus'] ?? [];

    // --- Twig environment: ArrayLoader preloaded with the main template
    // plus the two chrome partials (if provided) under the SAME literal
    // names {{ wpcanai_template('header'/'footer') }} calls use — the real
    // wpcanai_template() looks a template up by that name and renders it
    // through the SAME environment, which is exactly what re-using the
    // ArrayLoader like this reproduces.
    $templates = ['main' => (string) ($ctx['mainTemplateSource'] ?? '')];
    if (!empty($ctx['headerTemplateSource'])) {
        $templates['header'] = (string) $ctx['headerTemplateSource'];
    }
    if (!empty($ctx['footerTemplateSource'])) {
        $templates['footer'] = (string) $ctx['footerTemplateSource'];
    }
    $loader = new \Twig\Loader\ArrayLoader($templates);
    $twig = new \Twig\Environment($loader, ['cache' => false, 'debug' => false, 'auto_reload' => false]);

    $safeMarkup = static fn(string $html = '') => new \Twig\Markup($html, 'UTF-8');

    // --- home_url()-family --------------------------------------------
    $homeUrl = static function ($path = '') use ($siteUrl) {
        $path = (string) $path;
        if ($path === '') return $siteUrl . '/';
        return $siteUrl . '/' . ltrim($path, '/');
    };

    // --- get_menu() — real nav data harvested from the representative
    // capture (sampleHarvest.mjs::harvestMenuItems), keyed by the SAME
    // theme-independent locations WPCanAI itself registers
    // (wpcanai_primary/wpcanai_footer) — see TwigFactory.php's real
    // implementation for the {title,url,target,classes,active} shape this
    // mirrors.
    $getMenu = static function ($location) use ($menus) {
        $items = $menus[$location] ?? [];
        return is_array($items) ? $items : [];
    };

    // --- wpcanai_template() — resolves 'header'/'footer' (or any other
    // preloaded name) against the SAME Twig environment/loader, exactly
    // like the real plugin's default callback (wpcanai_get_template_by_name
    // + wpcanai_do_render), minus the DB lookup (name -> preloaded template
    // string is a direct map here, since there is no wpcanai_template CPT
    // to query offline). A name with nothing preloaded for it returns ''
    // (Markup) — matches the real function's "template not found" path.
    //
    // Recursion guard: a real, reproduced bug (not hypothetical) — an
    // earlier hand-authored header.html documented its own include
    // mechanism in an HTML comment that quoted the actual
    // {{ wpcanai_template('header') }} syntax. Twig parses its own
    // delimiters wherever they appear, comment or not, so that "helpful"
    // comment made header.html call itself while rendering itself: true
    // infinite recursion, which PHP eventually stops only via an
    // UNCATCHABLE "allowed memory size exhausted" fatal (not a \Throwable —
    // the surrounding try/catch below never sees it), after burning through
    // however much memory the limit allows. This counter turns that into an
    // immediate, catchable, clearly-worded exception the very first time it
    // would recurse instead — still tells the caller exactly what broke,
    // just without the multi-second memory-exhaustion detour first.
    $templateDepth = 0;
    $wpcanaiTemplate = static function (array $context, $name, $vars = []) use ($twig, $templates, $safeMarkup, &$templateDepth) {
        if (!isset($templates[$name])) {
            return $safeMarkup('');
        }
        if (++$templateDepth > 10) {
            throw new RuntimeException(
                "wpcanai_template('{$name}') recursed more than 10 levels deep — a template almost " .
                "certainly includes itself, directly or via a chain (e.g. an HTML comment quoting this " .
                "call's own literal syntax; Twig parses delimiters inside comments too). Check {$name} " .
                "and whatever it includes for a call back to itself.",
            );
        }
        try {
            $merged = array_merge($context, is_array($vars) ? $vars : []);
            return $safeMarkup($twig->render($name, $merged));
        } finally {
            $templateDepth--;
        }
    };

    // --- wpcanai_get_posts_enriched() — see class doc-comment above for
    // why this returns pre-computed data rather than re-deriving it from
    // $args. `p` set => "self-enrich the current post" (single templates,
    // and woo:product's scoped leftover-fields call) => the SAME enriched
    // post Node already computed. `p` NOT set => a "related posts"/archive
    // style query => whatever real sibling-sample posts Node harvested for
    // this run (possibly empty, which is honest when there weren't enough
    // samples to build a related list from).
    $getPostsEnriched = static function ($args = []) use ($enrichedPost, $relatedPosts) {
        $args = is_array($args) ? $args : [];
        if (array_key_exists('p', $args) && $enrichedPost !== null) {
            return [$enrichedPost];
        }
        return is_array($relatedPosts) ? $relatedPosts : [];
    };

    $theContent = static function ($content) use ($safeMarkup) {
        if (empty($content)) return $safeMarkup('');
        return $safeMarkup((string) $content);
    };

    $noop = static fn(...$args) => '';
    $noopMarkup = static fn(...$args) => $safeMarkup('');

    // --- Register every function TwigFactory.php registers (WPCanAI core
    // + the WooCommerce extension). Anything not central to visual fidelity
    // is a safe no-op; the ones that matter for a meaningful score have a
    // real, data-backed implementation above.
    $functions = [
        'wp_head' => $noopMarkup,
        'wp_footer' => $noopMarkup,
        'bloginfo' => static function ($show = '') use ($siteUrl) {
            if ($show === 'name') return parse_url($siteUrl, PHP_URL_HOST) ?: 'Site';
            return '';
        },
        'language_attributes' => static fn($doctype = 'html') => 'lang="en"',
        'body_class' => static fn($class = '') => '',
        'current_url' => static fn() => $siteUrl . '/',
        'is_current_url' => static fn($url) => false,
        'media_url' => static fn($id, $size = 'full') => '',
        'image_attrs' => $noopMarkup,
        'id_url' => static fn($id) => $homeUrl('?p=' . (int) $id),
        'post_url' => static fn($id) => $homeUrl('?p=' . (int) $id),
        'term_url' => static fn($id) => $homeUrl('?term=' . (int) $id),
        'slug_url' => static fn($slug, $postType = 'page') => $homeUrl($slug),
        'the_content' => $theContent,
        'shortcode' => $noopMarkup,
        'wpcanai_get_posts_enriched' => $getPostsEnriched,
        'wpcanai_get_terms_enriched' => static fn($args = []) => [],
        'wpcanai_template' => ['callback' => $wpcanaiTemplate, 'needs_context' => true],
        'wp_nonce_field' => $noopMarkup,
        'get_menu' => $getMenu,
        'the_posts_pagination' => $noopMarkup,
        'wpcanai_paginate_links' => $noopMarkup,
        'wpcanai_pagination' => $noopMarkup,
        '__' => static fn($text, $domain = null) => $text,
        '_x' => static fn($text, $ctx2, $domain = null) => $text,
        '_n' => static fn($single, $plural, $n, $domain = null) => ((int) $n === 1 ? $single : $plural),
        'current_language' => static fn() => 'en',
        'language_switcher' => static fn() => [],
        't' => static fn($source) => $source,
        'tmedia' => static fn($id, $size = 'full') => '',
        'current_lang' => static fn() => 'en',
        'languages' => static fn() => [],
        'lang_url' => static fn($slug) => $siteUrl . '/',
        'home_url' => $homeUrl,
        'site_url' => $homeUrl,
        'admin_url' => static fn($path = '') => $siteUrl . '/wp-admin/' . ltrim((string) $path, '/'),
        'rest_url' => static fn($path = '') => $siteUrl . '/wp-json/' . ltrim((string) $path, '/'),
        'get_option' => static fn($name, $default = false) => $default,
        'custom_logo' => $noopMarkup,
        'is_user_logged_in' => static fn() => false,
        'current_user' => static fn() => null,
        'user_can' => static fn($cap) => false,
        'login_url' => static fn($redirect = '') => $siteUrl . '/wp-login.php',
        'logout_url' => static fn($redirect = '') => $siteUrl . '/wp-login.php?action=logout',
        'is_active_sidebar' => static fn($id) => false,
        'sidebar' => $noopMarkup,
        'comments_open' => static fn($postId = null) => false,
        'get_comments_list' => static fn($postId = null, $args = []) => [],
        'comment_form' => $noopMarkup,
        'breadcrumbs' => static fn($args = []) => [['title' => 'Home', 'url' => $homeUrl('')]],
        // --- WooCommerce (registered unconditionally: harmless if unused,
        // and a woo:product single template may reference wc_price()/
        // wc_add_to_cart_form() even though structural-page functions like
        // wc_cart_totals() are only ever relevant to page kinds this
        // harness's Node caller doesn't attempt).
        'wc_get_product' => static fn($id = null) => null,
        'wc_price' => static function ($price, $args = []) use ($safeMarkup) {
            return $safeMarkup('<span class="woocommerce-Price-amount"><bdi>' . htmlspecialchars((string) $price) . '</bdi></span>');
        },
        'wc_add_to_cart_form' => static function ($product = null) use ($safeMarkup) {
            return $safeMarkup('<button type="submit" class="single_add_to_cart_button">Add to cart</button>');
        },
        'wc_hook' => $noopMarkup,
        'wc_shop_url' => static fn() => $homeUrl('shop'),
        'wc_update_cart_nonce' => static fn() => '',
        'wc_get_cart_url' => static fn() => $homeUrl('cart'),
        'wc_get_checkout_url' => static fn() => $homeUrl('checkout'),
        'wc_cart_totals' => $noopMarkup,
        'wc_checkout_form' => $noopMarkup,
        'wc_cart_block' => $noopMarkup,
        'wc_checkout_block' => $noopMarkup,
        'wc_print_notices' => $noopMarkup,
        'wc_form_field' => $noopMarkup,
        'wc_pagination' => $noopMarkup,
    ];

    foreach ($functions as $name => $config) {
        $callback = is_array($config) ? $config['callback'] : $config;
        $options = is_array($config) && !empty($config['needs_context']) ? ['needs_context' => true, 'is_safe' => ['html']] : ['is_safe' => ['html']];
        $twig->addFunction(new \Twig\TwigFunction($name, $callback, $options));
    }

    // --- Build the render context. `post` stays bare (ID/post_title/
    // post_content/post_excerpt/post_name) for a CPT single/archive-card —
    // matches transform-template.md's documented contract that a bare
    // `post` has no .fields/.featured_image/.taxonomy_items until
    // self-enriched via wpcanai_get_posts_enriched() (registered above). For
    // a woo:product single, Node's `context.post` already carries `.wc.*`
    // directly (the real plugin's automatic single-product takeover
    // populates that onto the bare $post before the template ever runs, so
    // there is no separate enrichment step to reproduce for natives).
    $renderContext = [];
    if ($post !== null) $renderContext['post'] = $post;
    if ($posts !== null) $renderContext['posts'] = $posts;

    $html = $twig->render('main', $renderContext);

    if (file_put_contents($outputPath, $html) === false) {
        throw new RuntimeException("could not write rendered output to: {$outputPath}");
    }
    exit(0);
} catch (\Throwable $e) {
    fwrite(STDERR, get_class($e) . ': ' . $e->getMessage() . "\n");
    exit(1);
}
