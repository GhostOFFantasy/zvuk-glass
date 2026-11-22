'use strict';
/* Пресеты фиксированных полос приложения (32 Гц–16 кГц), с явным запасом от клиппинга. */
(function () {
  const models = [
    {
      id: 'nothing', name: 'Nothing Headphone (1)',
      description: 'Две кривые адаптированы по АЧХ SoundGuys, а «Глубокий бас» — авторский тембральный пресет Nova. Это отправные точки, а не калибровка вашего экземпляра.',
      presets: [
        {
          id: 'nothing-sg-balanced', name: 'Баланс · SoundGuys',
          description: 'Более полная коррекция: убирает избыток глубокого баса и акцент в верхней середине, восстанавливая верхний диапазон. Для знакомых записей сравнивайте с режимом «Ровный».',
          bands: [-10, -3.5, 0, 3, 1, -0.5, -4.5, -3.5, -2.5, 8], preamp: -6.5,
          basis: 'адаптация АЧХ', source: 'Измерения SoundGuys', sourceUrl: 'https://www.soundguys.com/product/nothing-headphone-1/',
        },
        {
          id: 'nothing-sg-soft', name: 'Комфорт · мягкая коррекция',
          description: 'Около 65% полной коррекции: сохраняет больше исходного характера Nothing и подходит как более спокойная отправная точка для длительного прослушивания.',
          bands: [-6.5, -2, 0, 2, 0.5, 0, -3, -2, -1.5, 8], preamp: -6.5,
          basis: 'мягкая адаптация', source: 'Измерения SoundGuys', sourceUrl: 'https://www.soundguys.com/product/nothing-headphone-1/',
        },
        {
          id: 'nothing-bass-orbit', name: 'Nova · глубокий бас',
          description: 'Плотный саббас и упругий удар без сильного подъёма середины. Верхние полосы оставлены открытыми, а уровень −4 дБ сохраняет запас от перегрузки.',
          bands: [3.5, 4, 3, 1, 0, -0.5, -0.5, 0, 0.5, 1], preamp: -4,
          basis: 'авторский тембральный пресет', source: 'Настроено для Zvuk Nova',
        },
      ],
    },
    {
      id: 'sony', name: 'Sony WH-1000XM4',
      description: 'Два варианта AutoEq на разных измерениях и авторский басовый пресет Nova. Полосы измеренных профилей перенесены на ближайшие частоты приложения.',
      presets: [
        {
          id: 'sony-xm4-oratory', name: 'AutoEq · oratory1990',
          description: 'Коррекция к цели Harman по измерениям oratory1990: сдержанный бас, заметно раскрытая область присутствия около 2 кГц и мягкие высокие.',
          bands: [-4.3, -1.8, -5.8, -1.4, 0.5, -0.6, 6, -0.8, 1, -2.2], preamp: -5.8,
          basis: 'AutoEq · Fixed Band', source: 'Исходный пресет AutoEq', sourceUrl: 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/oratory1990/over-ear/Sony%20WH-1000XM4/Sony%20WH-1000XM4%20FixedBandEQ.txt',
        },
        {
          id: 'sony-xm4-rtings', name: 'AutoEq · RTINGS',
          description: 'Альтернатива по замерам RTINGS на B&K 5128: немного иной баланс середины, меньше энергии на 8 кГц и больше воздуха на самой верхней полосе.',
          bands: [-3.3, -0.6, -5.8, -1, 1.3, 0.8, 5.1, -0.8, -1.5, 2.4], preamp: -5.1,
          basis: 'AutoEq · Fixed Band', source: 'Исходный пресет AutoEq', sourceUrl: 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/Rtings/Bruel%20%26%20Kjaer%205128%20over-ear/Sony%20WH-1000XM4/Sony%20WH-1000XM4%20FixedBandEQ.txt',
        },
        {
          id: 'sony-xm4-bass-orbit', name: 'Nova · басовая орбита',
          description: 'Дополнительный вес в области 32–125 Гц с мягким спадом к середине. Подходит для электроники и хип-хопа; предусилитель −4 дБ ограничивает риск клиппинга.',
          bands: [2.5, 4, 3.5, 0.5, -0.5, -0.5, 0, 0, 0.5, 1], preamp: -4,
          basis: 'авторский тембральный пресет', source: 'Настроено для Zvuk Nova',
        },
      ],
    },
  ];
  window.HeadphoneEQ = {
    models,
    get(id) {
      for (const model of models) {
        const preset = model.presets.find((p) => p.id === id);
        if (preset) return { ...preset, model: model.name, modelId: model.id };
      }
      return null;
    },
  };
})();
