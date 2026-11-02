import { t, isFrench } from '../i18n';

// The gear categories, shared by the picker and the activity page. `single` is the label used on
// one item (activity page chips), `label` the section title.
export function gearKinds() {
  return [
    { type: 'Bike',    label: t.gearBikes,   single: isFrench ? 'Vélo' : 'Bike' },
    { type: 'Shoes',   label: t.gearShoes,   single: isFrench ? 'Chaussures' : 'Shoes' },
    { type: 'Board',   label: t.gearBoards,  single: isFrench ? 'Planche' : 'Board' },
    { type: 'Sail',    label: t.gearSails,   single: isFrench ? 'Voile' : 'Sail' },
    { type: 'Wing',    label: t.gearWings,   single: isFrench ? 'Aile' : 'Wing' },
    { type: 'Foil',    label: t.gearFoils,   single: 'Foil' },
    { type: 'Fin',     label: t.gearFins,    single: isFrench ? 'Aileron' : 'Fin' },
  ];
}

export function gearKindOf(type: string) {
  const ty = type.toLowerCase();
  return gearKinds().find(k => k.type.toLowerCase() === ty || (k.type === 'Shoes' && ty.startsWith('shoe')));
}
