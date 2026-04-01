# Morph — Full Working Example 2

> Scenario: **Restaurant Owner & Catering Manager**
> Run these prompts in order in a single fresh session.

---

## Step 1 — Build the full data model (1 prompt)

```
I own a restaurant. I need to track my menu items with prices, my suppliers with contact info, and my orders with order status and total amount.
```

**What happens:**

- Creates 3 linked tables: `menu_items`, `suppliers`, `orders`
- `menu_items` gets a `supplier TEXT` column linked to suppliers
- `orders` gets a `menu_item TEXT` column linked to menu_items
- FK arrows appear on canvas between all 3 cards
- Relations toggle appears top-right

**Expected columns:**

- `menu_items`: name (text), category (text), price (numeric), supplier (text)
- `suppliers`: name (text), contact (text), phone (text), email (text)
- `orders`: menu_item (text), quantity (integer), total_amount (numeric), status (text), order_date (date)

---

## Step 2 — Add suppliers

```
New supplier: Fresh Farms, contact is Ali, phone 0555-123-456
```

```
New supplier: Ocean Catch, contact is Youssef, phone 0555-789-012
```

```
New supplier: Bakery Bros, contact is Nour, phone 0555-345-678
```

**What happens:**

- Slide panel opens pre-filled with extracted values
- Confirm each one — rows appear in the suppliers card

---

## Step 3 — Add menu items (link to suppliers)

```
Add menu item: Grilled Salmon, seafood category, 85 dinars, from Ocean Catch
```

```
Add menu item: Margherita Pizza, pizza category, 45 dinars, from Bakery Bros
```

```
Add menu item: Caesar Salad, salads category, 35 dinars, from Fresh Farms
```

```
Add menu item: Beef Burger, burgers category, 55 dinars, from Fresh Farms
```

```
Add menu item: Chocolate Cake, desserts category, 40 dinars, from Bakery Bros
```

**What to check:**

- Slide panel shows supplier dropdown populated with Fresh Farms, Ocean Catch, Bakery Bros
- Each menu item links to the correct supplier

---

## Step 4 — Place orders (mixed case names to test ILIKE)

```
New order: 3 grilled salmon, total 255, status confirmed, today
```

```
New order: 5 margherita pizza, total 225, status pending, today
```

```
New order: 2 BEEF BURGER, total 110, status delivered, today
```

```
New order: 4 caesar salad, total 140, status confirmed, today
```

```
New order: 1 chocolate cake, total 40, status pending, today
```

```
New order: 6 Grilled Salmon, total 510, status delivered, today
```

**What to check:**

- `grilled salmon` (lowercase) and `BEEF BURGER` (uppercase) both match — ILIKE
- Slide panel shows menu_item dropdown populated with all 5 items
- Total 6 orders placed

---

## Step 5 — Stat queries (should return KPI cards)

```
What is the total revenue from all orders?
```

```
How many orders are pending?
```

```
What is the average order total?
```

**What happens:** Single-number stat cards appear on canvas (violet accent, large number)

**Expected values:**

- Total revenue: 1280
- Pending orders: 2
- Average order total: ~213.33

---

## Step 6 — Bar chart queries

```
Show me total revenue per menu item
```

```
How many orders per status?
```

```
Show me revenue by supplier
```

**What happens:** Bar chart cards appear — violet bars, labels below, values above

**Expected for revenue per item:**

- Grilled Salmon: 765 (255 + 510)
- Margherita Pizza: 225
- Beef Burger: 110
- Caesar Salad: 140
- Chocolate Cake: 40

---

## Step 7 — Insight questions (LLM interprets the data)

```
What is my best selling item?
```

**Expected:** Grilled Salmon — 9 units ordered across 2 orders, 765 dinars total revenue.

```
Which supplier brings in the most revenue?
```

**Expected:** Ocean Catch (Grilled Salmon = 765 dinars). Requires cross-table reasoning.

```
Are there any pending orders I should follow up on?
```

**Expected:** LLM sees 2 pending orders: Margherita Pizza (225) and Chocolate Cake (40), suggests following up.

```
What percentage of orders are delivered?
```

**Expected:** 2 out of 6 = 33.3% delivered.

```
Is my desserts category profitable?
```

**Expected:** Only 1 Chocolate Cake order (40 dinars) — LLM should note it's the lowest earner.

---

## Step 8 — Cross-table query (JOIN)

```
Show me each menu item with its supplier name and total orders placed
```

**Expected:** Table card with columns: menu item, supplier, order count — requires JOIN across 3 tables.

```
Which suppliers have items that haven't been ordered yet?
```

**Expected:** If all items have orders, system says "all items have been ordered."

---

## Step 9 — Schema evolution (ALTER)

```
Add a rating column to the menu_items table
```

**What happens:** `menu_items` card refreshes immediately showing the new column — no page reload.

```
Add a delivery_address column to the orders table
```

---

## Step 10 — Add a new linked table mid-session

```
I also want to track customer feedback and reviews for each menu item
```

**Expected:**

- Creates `reviews` table with `menu_item TEXT`, `customer_name TEXT`, `rating INTEGER`, `comment TEXT`, `review_date DATE`
- FK arrow appears connecting it to `menu_items`
- Menu item dropdown in the insert form shows existing items

Add reviews:

```
New review for Grilled Salmon: Amira gave 5 stars, said "best salmon in town"
```

```
New review for Margherita Pizza: Karim gave 4 stars, said "great crust but needs more cheese"
```

```
New review for Beef Burger: Lina gave 3 stars, said "average, nothing special"
```

---

## Step 11 — Add a second-level linked table (relation to a relation)

This tests whether the system remembers existing relations when adding a new table.

```
I want to track daily specials — which menu item is on special, the discount percentage, and the date
```

**Expected:**

- System sees existing relations: `orders.menu_item → menu_items`, `reviews.menu_item → menu_items`, `menu_items.supplier → suppliers`
- Creates `daily_specials` with `menu_item TEXT`, `discount_percentage INTEGER`, `special_date DATE`
- FK arrow appears from `daily_specials` → `menu_items`
- Menu item dropdown in insert form shows Grilled Salmon, Margherita Pizza, etc.

Add specials:

```
Today's special: Margherita Pizza, 20% off
```

```
Today's special: Caesar Salad, 15% off
```

**What to check:**

- `menu_item` dropdown is pre-populated from existing `menu_items` rows
- FK arrows on canvas: `daily_specials → menu_items` and `menu_items → suppliers`

---

## Step 12 — Cross-relation insight queries

```
Which menu items have the best reviews?
```

**Expected:** Grilled Salmon (5 stars), Margherita Pizza (4 stars), Beef Burger (3 stars)

```
Show me items on special today with their original price and discount
```

**Expected:** Table joining daily_specials and menu_items — Margherita Pizza 45 dinars 20% off, Caesar Salad 35 dinars 15% off

```
What is the average rating per supplier?
```

**Expected:** Requires joining reviews → menu_items → suppliers. Ocean Catch: 5.0, Bakery Bros: 4.0, Fresh Farms: 3.0

```
Which menu items have high orders but low ratings?
```

**Expected:** LLM cross-references order volume with review ratings for each item

---

## Tricky edge cases to test

| Prompt                                      | Expected behaviour                                               |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `grilled salmon` (lowercase) in any query   | ILIKE matching — works                                           |
| `BEEF BURGER` (all caps)                    | works                                                            |
| `total revenue from ocean catch`            | Cross-table join: orders → menu_items → suppliers                |
| `show me all orders`                        | Table result card with all 6 rows                                |
| `delete the salmon`                         | LLM should say it can't — no DELETE allowed                      |
| `what tables do i have?`                    | LLM lists them from session context                              |
| `add an allergens table for each menu item` | Creates `allergens` with `menu_item TEXT` linked to `menu_items` |

---

## What the canvas should look like after all steps

```
[suppliers]──────────[menu_items]──────[orders]
                          │
                          ├──────[reviews]
                          │
                          └──────[daily_specials]
```

- 5+ TableCards on canvas, all draggable
- Dashed violet FK arrows between them
- "Relations on" toggle button top-right
- Stat cards, bar charts, result tables scattered on canvas from queries
- Hover any arrow → tooltip: "Each order is linked to a menu item via 'menu_item'."

---

## Common failure modes and what they mean

| Error                             | Cause                                | Fix                                                                            |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| "I couldn't apply that change"    | LLM generated bad SQL                | Rephrase more explicitly, use snake_case names                                 |
| Slide panel shows empty dropdown  | Table has no rows yet                | Add rows to the referenced table first                                         |
| Relations arrows missing          | Column name doesn't match table name | Name the column exactly after the table (singular): `supplier` for `suppliers` |
| Stat card instead of bar chart    | Only 1 row returned                  | Add more data rows first                                                       |
| Revenue query returns wrong total | JOIN produced duplicates             | Check if the SQL uses DISTINCT or proper grouping                              |
