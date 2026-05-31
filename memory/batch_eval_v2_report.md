# Batch Eval v2 — 158 sold trips analysed

## Global PVP ratio (draft / real)

```
{
  "n": 157,
  "min": 0.357,
  "max": 3.813,
  "median": 1.256,
  "mean": 1.388,
  "stdev": 0.648,
  "p10": 0.668,
  "p90": 2.157
}
```

## By country

- **Italia** (n=75): ratio median=1.358 · mean=1.461 · activities 0.909x · hotel-diff median 1.5
- **España** (n=41): ratio median=1.288 · mean=1.364 · activities 1.1x · hotel-diff median 2
- **Portugal** (n=40): ratio median=1.073 · mean=1.301 · activities 1.0x · hotel-diff median 2
- **Marruecos** (n=2): ratio median=0.817 · mean=0.817 · activities 1.2x · hotel-diff median 6

## By sales agent

- **Giorgia Torre** (n=27): median ratio=1.498 · mean=1.546
- **Anita** (n=27): median ratio=1.161 · mean=1.326
- **Rita** (n=25): median ratio=1.514 · mean=1.52
- **Beatriz** (n=20): median ratio=1.185 · mean=1.242
- **Hector** (n=17): median ratio=1.365 · mean=1.545
- **Marina** (n=15): median ratio=1.073 · mean=1.222
- **Raquel** (n=13): median ratio=1.123 · mean=1.324
- **Janelle** (n=12): median ratio=1.224 · mean=1.201

## Error buckets

- severe_over_quote_>1.5x: 58
- severe_under_quote_<0.7x: 15
- big_hotel_diff_>3000eur: 80
- activity_over_+3: 17
- activity_under_-3: 20
- zero_city_overlap: 26

## Activities subtotal (draft€ / real€)

```
{
  "n": 157,
  "min": 0.211,
  "max": 3.287,
  "median": 1.145,
  "mean": 1.273,
  "stdev": 0.618,
  "p10": 0.513,
  "p90": 2.106
}
```


## Worst hotel overshoots (draft >> real)

- trn_b3c60e077ac7: draft 6974.3€ vs real 276.0€ → ratio 25.27x
- trn_0809f76c39aa: draft 15919.65€ vs real 785.0€ → ratio 20.28x
- trn_154ec0e6e365: draft 23752.0€ vs real 1175.0€ → ratio 20.21x
- trn_85139f2e8576: draft 24691.08€ vs real 1450.0€ → ratio 17.03x
- trn_d9bff99e4e84: draft 10696.0€ vs real 640.0€ → ratio 16.71x
- trn_294d515d2477: draft 7519.43€ vs real 507.0€ → ratio 14.83x
- trn_0867d092fd37: draft 12600.14€ vs real 870.0€ → ratio 14.48x
- trn_d6a4938a32b8: draft 7676.0€ vs real 676.0€ → ratio 11.36x
- trn_b20d0a6099b2: draft 15352.0€ vs real 1428.38€ → ratio 10.75x
- trn_bbad99c7da2c: draft 7247.56€ vs real 690.0€ → ratio 10.50x

## Worst hotel undershoots (draft << real)

- trn_5559c9dc87fe: draft 6127.19€ vs real 7364.0€ → ratio 0.83x
- trn_170eb1097fd9: draft 6506.0€ vs real 7845.0€ → ratio 0.83x
- trn_867eadddf314: draft 4805.44€ vs real 6898.99€ → ratio 0.70x
- trn_5c58d1b11d06: draft 2240.0€ vs real 3249.0€ → ratio 0.69x
- trn_31cd02ab0ccc: draft 1390.0€ vs real 2018.0€ → ratio 0.69x
- trn_0876ece4789c: draft 2504.41€ vs real 3736.0€ → ratio 0.67x
- trn_550905fdfd7f: draft 604.8€ vs real 925.0€ → ratio 0.65x
- trn_0770ee2b1d96: draft 790.0€ vs real 1240.0€ → ratio 0.64x
- trn_8b5c19b82e3a: draft 1408.0€ vs real 2265.0€ → ratio 0.62x
- trn_99d895abbd78: draft 2844.0€ vs real 5100.0€ → ratio 0.56x

## Zero city overlap (draft picked completely different cities)

- trn_f2c4c84f66bf (España, Marina): real=['Madrid', 'Logroño', 'La Rioja', 'San Sebastián', 'Bilbao'] · draft=['Barcelona', 'Seville', 'Granada', 'Malaga']
- trn_6931ef067c18 (Italia, Giorgia Torre): real=['Naples to Amalfi Coast (Sorrento)', 'Amalfi Coast (Sorrento)', 'Amalfi Coast (Sorrento) to Rome', 'Rome'] · draft=['Naples', 'Sorrento', 'Palermo']
- trn_0eb77f66cc60 (Portugal, Beatriz): real=['São Miguel', 'Terceira', 'Flores', 'Pico'] · draft=['Porto', 'Évora', 'Lisbon', 'Lagos']
- trn_217648a7ed58 (Italia, Beatriz): real=['Roma', 'Radda in Chianti', 'Monterosso al Mare', 'Firenze', 'Venezia'] · draft=['Rome', 'Florence', 'Verona', 'Venice']
- trn_40b9c17d2392 (Italia, Anita): real=['Lisbon', 'Lisbon - Porto', 'Porto', 'Porto - Lagos', 'Lagos', 'Lagos - Lisbon'] · draft=['Rome', 'Florence', 'Lake Garda', 'Milan']
- trn_0770ee2b1d96 (Italia, Rita): real=['Bari', 'Alberobello / Trulli', 'Matera / Alberobello', 'Torre Canne', 'Rome'] · draft=['Catania', 'Tropea', 'Cisternino']
- trn_d666f741e584 (España, Marina): real=['Milan', 'Florence', 'Rome'] · draft=['Barcelona', 'Tarragona', 'Teruel', 'Valencia', 'Cartagena', 'Nerja', 'Málaga']
- trn_afc19baf54ee (Italia, Beatriz): real=['Roma', 'Firenze'] · draft=['Rome', 'Siena', 'Sorrento']
- trn_dc494bd14131 (Italia, Beatriz): real=['Roma', 'Firenze', 'Venezia'] · draft=['Venice', 'Florence', 'Rome']
- trn_d6a4938a32b8 (Italia, Giorgia Torre): real=['Milan / Lake Garda', 'Lake Garda', 'Lake Garda / Brescia', 'Lake Garda / Verona', 'Verona / Valpolicella', 'Verona / Mantova', 'Verona to Milan Airport'] · draft=['Sorrento', 'Florence']
- trn_8b4832f4bc5d (Portugal, Hector): real=['Barcelona'] · draft=['Porto', 'Lisbon']
- trn_550905fdfd7f (Portugal, Marina): real=['Sao Miguel'] · draft=['Ponta Delgada', 'Pico Island']
- trn_667dd3965312 (Italia, Rita): real=['Roma', 'Roma > Firenze', 'Firenze', 'Firenze > San Gimignano', 'San Gimignano', 'San Gimignano > Bologna', 'Bologna', 'Bologna > Venezia', 'Venezia', 'Venezia > Milano', 'Milano'] · draft=['Rome', 'Tuscany', 'Florence']
- trn_d33d627076b9 (Portugal, Raquel): real=['Porto', 'Porto - Algarve', 'Algarve', 'Algarve - Lisbon', 'Lisbon - Departure'] · draft=['Lisbon', 'Lagos']
- trn_7e83de263cbf (Portugal, Hector): real=['Sao Miguel', 'Terceira', 'Pico Island', 'Pico Island / Faial'] · draft=['Ponta Delgada', 'Faial (Horta)', 'Flores Island']