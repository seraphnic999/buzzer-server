# Buzzer Dictionary Files

Each `.json` file in this folder is loaded automatically by the server on startup.

## Format

```json
{
  "category_name": "שם הקטגוריה",
  "entries": [
    {
      "id": "unique_id",
      "category_id": "category_key",
      "category_name": "שם הקטגוריה",
      "answer": "המילה הנכונה",
      "answer_niqqud": "הַמִּלָּה הַנְּכוֹנָה",
      "clues": [
        "רמז קשה...",
        "...",
        "רמז קל..."
      ],
      "grid": [
        "המילה הנכונה",
        "מילה קרובה 2",
        "..."
      ]
    }
  ]
}
```

## Rules
- `clues` must have exactly 10 items, ordered **hard → easy**
- `grid` must have exactly 32 items
- `grid[0]` must equal `answer` — the server shuffles it before presenting
- Files must be valid UTF-8 JSON

## Adding a new category
1. Create a new `.json` file in this folder following the format above
2. Commit & push to GitHub
3. Railway redeploys automatically — no other server changes needed
