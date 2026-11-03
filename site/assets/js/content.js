// The map of the known universe. y points UP, like it should.
// 1 unit at reference zoom = REF_SCALE css px.

export const REF_SCALE = 40;

export const PLACES = [
  { id: 'hello',    label: 'Hello',    x: 0,   y: 0,   color: '#5ed6e0', key: '1', file: 'hello.md' },
  { id: 'geogebra', label: 'GeoGebra', x: 22,  y: 9,   color: '#8f86e8', key: '2', file: 'geogebra/' },
  { id: 'mapplic',  label: 'Mapplic',  x: -21, y: -11, color: '#e06bd6', key: '3', file: 'mapplic/' },
  { id: 'stack',    label: 'Stack',    x: -17, y: 13,  color: '#a8d860', key: '4', file: 'stack.txt' },
  { id: 'contact',  label: 'Contact',  x: 9,   y: -19, color: '#f0b056', key: '5', file: 'contact.sh' },
];

// Route order (loops back to the start). Mapplic-style directions, minus the "recalculating".
export const TOUR = ['hello', 'geogebra', 'mapplic', 'stack', 'contact'];

export const placeById = (id) => PLACES.find((p) => p.id === id);
