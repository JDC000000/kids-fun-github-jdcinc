// lib/search/__fixtures__/regions.ts — Region hierarchy fixture (TSD §5B).
//
// Metro Vancouver → Municipality → Sub-area. Centroids are approximate WGS84 points
// for the fixture geo maths (radius/region tests).

import type { Region } from '../../geo/region';

export const REGION_IDS = {
  metro: 'metro',
  vancouver: 'van',
  northVan: 'nvan',
  westVan: 'wvan',
  burnaby: 'bby',
  richmond: 'rmd',
  vanEast: 'van-east',
  vanWestSide: 'van-westside',
} as const;

export const REGIONS: Region[] = [
  { id: 'metro', name: 'Metro Vancouver', level: 'metro', parentId: null, centroid: { lat: 49.25, lng: -123.0 } },
  { id: 'van', name: 'Vancouver', level: 'municipality', parentId: 'metro', centroid: { lat: 49.2606, lng: -123.114 } },
  { id: 'nvan', name: 'North Vancouver', level: 'municipality', parentId: 'metro', centroid: { lat: 49.32, lng: -123.07 } },
  { id: 'wvan', name: 'West Vancouver', level: 'municipality', parentId: 'metro', centroid: { lat: 49.33, lng: -123.16 } },
  { id: 'bby', name: 'Burnaby', level: 'municipality', parentId: 'metro', centroid: { lat: 49.2488, lng: -122.98 } },
  { id: 'rmd', name: 'Richmond', level: 'municipality', parentId: 'metro', centroid: { lat: 49.1666, lng: -123.1336 } },
  { id: 'van-east', name: 'East Van', level: 'sub_area', parentId: 'van', centroid: { lat: 49.26, lng: -123.07 } },
  { id: 'van-westside', name: 'West Side', level: 'sub_area', parentId: 'van', centroid: { lat: 49.25, lng: -123.16 } },
];
