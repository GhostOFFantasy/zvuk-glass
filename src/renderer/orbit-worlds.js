'use strict';
/* Музыкальные миры: те же параметры, что и у «Соберите свою частоту». */
(function () {
  const worlds = [
    {
      id: 'any', name: 'Свободный поток', short: 'Без фильтров', icon: 'sparkle',
      description: 'Только ваши вкусы и рекомендации Zvuk — без ограничений по настроению и жанрам.',
      color: '#7fdcff', accent: '#b5a4ff',
      settings: { mood: 'any', lang: 'any', pop: 'any', genres: [] },
    },
    {
      id: 'calm', name: 'Лунный покой', short: 'Амбиент · акустика', icon: 'moon',
      description: 'Мягкие аранжировки, эмбиент и акустика для спокойного фона и отдыха.',
      color: '#6dd5ed', accent: '#7d9dff',
      settings: { mood: 'calm', lang: 'any', pop: 'any', genres: ['easy_listening_ambient', 'instrumental_acoustic'] },
    },
    {
      id: 'rock', name: 'Рок-гигант', short: 'Рок · живой драйв', icon: 'bolt',
      description: 'Гитары, барабаны и энергичный темп — от любимых хитов до новых открытий.',
      color: '#ff9b68', accent: '#ff526e',
      settings: { mood: 'energetic', lang: 'any', pop: 'any', genres: ['rock'] },
    },
    {
      id: 'sad', name: 'После дождя', short: 'Инди · тёплая грусть', icon: 'cloud',
      description: 'Интроспективный инди и акустика для тихих эмоций, без излишней мрачности.',
      color: '#a8b5ff', accent: '#747fb5',
      settings: { mood: 'sad', lang: 'any', pop: 'any', genres: ['indie', 'instrumental_acoustic'] },
    },
    {
      id: 'pulse', name: 'Пульс', short: 'Электроника · хип-хоп', icon: 'fire',
      description: 'Ритм, бас и движение: электронная музыка и хип-хоп для прилива энергии.',
      color: '#ffd076', accent: '#ff6b9a',
      settings: { mood: 'energetic', lang: 'any', pop: 'any', genres: ['electronic', 'hip_hop'] },
    },
    {
      id: 'sunny', name: 'Солнечная', short: 'Поп · любимые хиты', icon: 'sun',
      description: 'Светлая поп-музыка и известные хиты для хорошего настроения.',
      color: '#ffe58a', accent: '#ff9e8a',
      settings: { mood: 'fun', lang: 'any', pop: 'popular', genres: ['pop'] },
    },
    {
      id: 'instrumental', name: 'Без слов', short: 'Инструментал · эмбиент', icon: 'note',
      description: 'Спокойная инструментальная музыка и эмбиент для концентрации и работы.',
      color: '#9ce4d5', accent: '#7098d8',
      settings: { mood: 'calm', lang: 'instrumental', pop: 'any', genres: ['easy_listening_ambient'] },
    },
  ];
  const get = (id) => worlds.find((w) => w.id === id) || worlds[0];
  window.OrbitWorlds = {
    all: worlds,
    satellites: worlds.slice(1),
    get,
    settings(id) {
      const w = get(id);
      return { ...w.settings, genres: [...w.settings.genres], world: w.id };
    },
  };
})();
