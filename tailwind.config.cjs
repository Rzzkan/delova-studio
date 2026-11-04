/** Palet mengikuti gaya TailAdmin (open source, MIT). */
module.exports = {
  darkMode: 'class',
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      colors: {
        primary: '#3C50E0',
        sidebar: '#1C2434',
        boxdark: '#24303F',
        bodydark: '#1A222C',
        stroke: '#E2E8F0',
        strokedark: '#2E3A47',
        graylight: '#F1F5F9',
        body: '#64748B',
        success: '#10B981',
        danger: '#D34053',
        warning: '#FFA70B',
      },
      boxShadow: { card: '0px 1px 3px rgba(0,0,0,0.08), 0px 1px 2px rgba(0,0,0,0.04)' },
    },
  },
};
