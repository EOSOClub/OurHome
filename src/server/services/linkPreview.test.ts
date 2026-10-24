import { describe, expect, it } from 'vitest';
import { parsePreview } from './linkPreview';

// Trimmed from a real Amazon product page (October 2026): no og: tags, the
// picture on #landingImage and the price in the "price to pay" block.
const AMAZON = `<html><head><title>Amazon.com: Instant Pot Duo 6 Qt : Home &amp; Kitchen</title>
<meta property="og:title" content="Instant Pot Duo | Amazon"></head><body>
<span id="productTitle" class="a-size-large product-title-word-break">        Instant Pot Duo 6 Qt 7-in-1 Electric Pressure Cooker       </span>
<img alt="Instant Pot" src="https://m.media-amazon.com/images/I/71MLaYtMFOL._AC_SY300_.jpg" data-mb-pv-slot-index="0" data-old-hires="https://m.media-amazon.com/images/I/71MLaYtMFOL._AC_SL1500_.jpg" id="landingImage">
<span class="a-offscreen">List: $89.99</span>
<span id="apex-pricetopay-accessibility-label" data-pricetopay-label="{priceToPay}" class="aok-offscreen"> $71.89 </span>
<span class="a-price priceToPay apex-pricetopay-value" data-a-size="xl"><span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">71<span class="a-price-decimal">.</span></span><span class="a-price-fraction">89</span></span></span>
</body></html>`;

// Trimmed from a real Hy-Vee product page: og:title and og:image, but the price
// only in its JSON-LD Product.
const HYVEE = `<html><head>
<meta property="og:title" content="Accu-Chek Compact Plus Test Strips | Hy-Vee Aisles Online Grocery Shopping">
<meta property="og:image" content="https://cdn.hy-vee.com/products/0075537474190/CL/a_large.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","image":["https://cdn.hy-vee.com/products/0075537474190/CL/a_large.jpg"],"name":"Accu-Chek Compact Plus Test Strips","offers":{"@type":"Offer","price":"48.00","priceCurrency":"USD"}}</script>
</head><body></body></html>`;

describe('parsePreview', () => {
  it('reads Amazon: the product title, the large picture and the price to pay', () => {
    expect(parsePreview(AMAZON, 'https://www.amazon.com/dp/B00FLYWNYQ')).toEqual({
      title: 'Instant Pot Duo 6 Qt 7-in-1 Electric Pressure Cooker',
      imageUrl: 'https://m.media-amazon.com/images/I/71MLaYtMFOL._AC_SL1500_.jpg',
      price: 71.89,
    });
  });

  it('reads only the price from a label that goes on (a sale)', () => {
    // Seen 2026-10-23 on a LEGO set: "$39.98 with 20 percent savings" read as 39.982.
    const sale = AMAZON.replace(' $71.89 </span>', '$39.98 with 20 percent savings </span>');
    expect(parsePreview(sale, 'https://www.amazon.com/dp/B00FLYWNYQ').price).toBe(39.98);
    const big = AMAZON.replace(' $71.89 </span>', '$1,299.00 with 5 percent savings </span>');
    expect(parsePreview(big, 'https://www.amazon.com/dp/B00FLYWNYQ').price).toBe(1299);
  });

  it('reads the shown Amazon digits when the price label is missing', () => {
    const html = AMAZON.replace(/<span id="apex-pricetopay-accessibility-label"[^\n]*\n/, '');
    expect(parsePreview(html, 'https://www.amazon.com/dp/B00FLYWNYQ').price).toBe(71.89);
  });

  it('keeps Amazon markup to Amazon pages', () => {
    const preview = parsePreview(AMAZON, 'https://shop.example.com/item');
    expect(preview.imageUrl).toBeNull();
    expect(preview.price).toBeNull();
  });

  it('reads a JSON-LD Product price, preferring its name to og:title', () => {
    expect(parsePreview(HYVEE, 'https://www.hy-vee.com/aisles-online/p/1497/')).toEqual({
      title: 'Accu-Chek Compact Plus Test Strips',
      imageUrl: 'https://cdn.hy-vee.com/products/0075537474190/CL/a_large.jpg',
      price: 48,
    });
  });

  it('finds a Product inside @graph, with an AggregateOffer and an ImageObject', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":["Product"],"name":"Eggs",
      "image":{"@type":"ImageObject","url":"/img/eggs.jpg"},"offers":[{"@type":"AggregateOffer","lowPrice":2.99}]}]}</script>`;
    expect(parsePreview(html, 'https://grocer.example.com/eggs')).toEqual({
      title: 'Eggs',
      imageUrl: 'https://grocer.example.com/img/eggs.jpg',
      price: 2.99,
    });
  });

  it('skips a broken JSON-LD block and reads the next one', () => {
    const html = `<script type="application/ld+json">{oops</script>
      <script type="application/ld+json">{"@type":"Product","name":"Milk","offers":{"priceSpecification":{"price":"3.49"}}}</script>`;
    expect(parsePreview(html, 'https://grocer.example.com/milk')).toMatchObject({ title: 'Milk', price: 3.49 });
  });

  it('reads a microdata price', () => {
    const html = `<title>Bread</title><span itemprop="priceCurrency" content="USD"></span><meta itemprop="price" content="4.25">`;
    expect(parsePreview(html, 'https://grocer.example.com/bread').price).toBe(4.25);
  });

  it('still prefers meta tags when a page has them', () => {
    const html = `<meta property="og:title" content="Mug"><meta property="og:image" content="https://cdn.example.com/mug.jpg">
      <meta property="product:price:amount" content="12.00">`;
    expect(parsePreview(html, 'https://shop.example.com/mug')).toEqual({
      title: 'Mug',
      imageUrl: 'https://cdn.example.com/mug.jpg',
      price: 12,
    });
  });

  it('does not read data-name or data-content as name or content', () => {
    const html = `<meta data-name="og:image" content="https://cdn.example.com/wrong.jpg"><meta property="og:image" data-content="x" content="https://cdn.example.com/right.jpg">`;
    expect(parsePreview(html, 'https://shop.example.com/a').imageUrl).toBe('https://cdn.example.com/right.jpg');
  });
});
