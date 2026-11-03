// The map of the known universe. y points UP, like it should.
// 1 unit at reference zoom = REF_SCALE css px.

export const REF_SCALE = 40;

export const PLACES = [
  { id: 'hello',    label: 'Hello',    x: 0,   y: 0,   color: '#3df5ff', key: '1', file: 'hello.md' },
  { id: 'geogebra', label: 'GeoGebra', x: 22,  y: 9,   color: '#8a7dff', key: '2', file: 'geogebra/' },
  { id: 'mapplic',  label: 'Mapplic',  x: -21, y: -11, color: '#ff3df2', key: '3', file: 'mapplic/' },
  { id: 'stack',    label: 'Stack',    x: -17, y: 13,  color: '#b6ff3d', key: '4', file: 'stack.txt' },
  { id: 'contact',  label: 'Contact',  x: 9,   y: -19, color: '#ffb23d', key: '5', file: 'contact.sh' },
];

// Route order (loops back to the start). Mapplic-style directions, minus the "recalculating".
export const TOUR = ['hello', 'geogebra', 'mapplic', 'stack', 'contact'];

// Minimap extent, in world units.
export const WORLD_BOUNDS = { minX: -36, maxX: 36, minY: -28, maxY: 24 };

export const placeById = (id) => PLACES.find((p) => p.id === id);
